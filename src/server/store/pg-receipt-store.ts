/* Postgres ReceiptStore (hosted demo). Reproduces the review-hardened
 * ConsumptionStore (src/consumption/store.ts — FROZEN) claim semantics
 * directly in Postgres SQL; it does NOT reinterpret them:
 *   1. domain-separated digest, validated against any caller-supplied
 *      expectedDigest BEFORE anything is written;
 *   2. atomic first-claim — exactly one successor invocation can ever
 *      succeed per decision (advisory xact lock + PK + 23505 fallback);
 *   3. expiry is RE-SAMPLED inside the write boundary — the committed
 *      receipt never authorizes a decision that expired while the claimant
 *      waited for the slot (the review P1 lesson);
 *   4. replay only with IDENTICAL binding (digest column, receipt fields,
 *      and successor must all match); anything else is rejected and
 *      history is preserved.
 * The digest encoding itself is imported from the frozen module so there is
 * one source of truth. validateExpiry is copied verbatim from it (it is
 * module-private there and the file is frozen).
 *
 * Out of scope here, deliberately: the local-owner admission machinery
 * (StoreAdmission/writer inventory/local_owner_slots probe) is SQLite
 * local-owner-tooling, not part of the receipt seam's claim semantics; the
 * hosted demo has no candidate-profile slots to conflict with. */
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { decisionDigest, CONSUMPTION_SCHEMA } from '../../consumption/store'
import type { DecisionRecord, ClaimResult, ConsumptionReceipt } from '../../consumption/store'
import type { ReceiptStore } from './sqlite-receipt-store'
import { resolvePostgresConfig, type PostgresStoreConfig } from './pg-run-store'

/** Same advisory-lock namespace rule as pg-run-store; distinct class id. */
const LOCK_CLAIM = 7002

/** Copied verbatim from the frozen src/consumption/store.ts (private there).
 * Require a real RFC3339 calendar date, not Date.parse's rollover or
 * locale-dependent shortcuts. Fractional seconds and explicit offsets are
 * supported; leap seconds are not supported by this local runtime. */
function validateExpiry(expiresAt: string): { ok: true, time: number } | { ok: false, detail: string } {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/.exec(expiresAt)
  const time = Date.parse(expiresAt)
  const year = match ? Number(match[1]) : 0
  const month = match ? Number(match[2]) : 0
  const day = match ? Number(match[3]) : 0
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (!match || !Number.isFinite(time) || month < 1 || month > 12 || day < 1 || day > days[month - 1]
    || Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59
    || Number(match[8] ?? 0) > 23 || Number(match[9] ?? 0) > 59) {
    return { ok: false, detail: 'expiry must be a valid RFC3339 timestamp' }
  }
  return { ok: true, time }
}

export class PostgresReceiptStore implements ReceiptStore {
  private readonly pool: Pool
  private schemaReady: Promise<void> | undefined
  private closed: Promise<void> | undefined

  constructor(config: PostgresStoreConfig = {}) {
    this.pool = new Pool({ ...resolvePostgresConfig(config), max: config.max ?? 5 })
  }

  /** Idempotent, lazy (the ReceiptStore seam has no initialize; the engine
   * only awaits the run store's). Memoized so concurrent first claims race
   * on one promise, not on duplicate DDL. */
  private ensureSchema(): Promise<void> {
    this.schemaReady ??= this.pool.query(`
      CREATE TABLE IF NOT EXISTS consumption_receipts (
        decision_id TEXT PRIMARY KEY,
        receipt_json TEXT NOT NULL,
        successor_invocation_id TEXT NOT NULL,
        decision_digest TEXT NOT NULL,
        claimed_at TEXT NOT NULL
      )
    `).then(() => undefined)
    return this.schemaReady
  }

  /** Transaction-scoped advisory lock keyed on the decision id: claimants
   * serialize on THIS decision only, inside a real Postgres transaction
   * (the network-database counterpart of ConsumptionStore's BEGIN
   * IMMEDIATE write slot). Auto-released at COMMIT/ROLLBACK. */
  private async withClaimSlot<T>(decisionId: string, body: (client: import('pg').PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [LOCK_CLAIM, decisionId])
      const value = await body(client)
      await client.query('COMMIT')
      return value
    } catch (err) {
      try { await client.query('ROLLBACK') } catch { /* connection already broken */ }
      throw err
    } finally {
      client.release()
    }
  }

  private async readClaim(client: { query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }, decisionId: string) {
    const result = await client.query(
      'SELECT receipt_json, successor_invocation_id, decision_digest FROM consumption_receipts WHERE decision_id = $1',
      [decisionId],
    )
    return result.rows[0] as { receipt_json: string, successor_invocation_id: string, decision_digest: string } | undefined
  }

  /** Ported verbatim from the frozen ConsumptionStore.checkReplay: replay is
   * valid ONLY when the stored claim binds this exact decision under the
   * current digest encoding AND the same successor. */
  private checkReplay(
    stored: { receipt_json: string, successor_invocation_id: string, decision_digest: string },
    decision: DecisionRecord,
    successor: string,
  ): ClaimResult {
    const receipt = JSON.parse(stored.receipt_json) as ConsumptionReceipt
    const digest = decisionDigest(decision)
    if (stored.decision_digest !== digest || receipt.decisionDigest !== digest
      || receipt.decisionId !== decision.decisionId || receipt.decisionRequestId !== decision.decisionRequestId
      || receipt.permittedAction !== decision.permittedAction || receipt.successorInvocationId !== stored.successor_invocation_id) {
      return { status: 'rejected', reason: 'digest_mismatch', detail: 'stored claim does not bind this exact decision under the current digest encoding; history was preserved' }
    }
    if (stored.successor_invocation_id !== successor) {
      return { status: 'rejected', reason: 'competing_successor', detail: `decision already claimed by invocation ${stored.successor_invocation_id}` }
    }
    return { status: 'replayed', receipt, note: 'identical decision and successor retry — original claim stands; this does not authorize reexecution' }
  }

  async claim(decision: DecisionRecord, successorInvocationId: string, expectedDigest?: string): Promise<ClaimResult> {
    await this.ensureSchema()
    if (expectedDigest !== undefined && expectedDigest !== decisionDigest(decision)) {
      return { status: 'rejected', reason: 'digest_mismatch', detail: 'provided digest does not match the decision record' }
    }
    let expiresAtTime: number | null = null
    if (decision.expiresAt !== undefined) {
      const validity = validateExpiry(decision.expiresAt)
      if (!validity.ok) return { status: 'rejected', reason: 'invalid_expiry', detail: validity.detail }
      expiresAtTime = validity.time
    }

    // Fast path: an existing claim is decided without touching the write
    // slot at all (same as the frozen store's pre-slot read).
    const poolRead = await this.readClaim(this.pool, decision.decisionId)
    if (poolRead) return this.checkReplay(poolRead, decision, successorInvocationId)

    try {
      return await this.withClaimSlot(decision.decisionId, async client => {
        // Inside the slot: a claimant that committed while we waited is
        // discovered here (the Postgres equivalent of the frozen store's
        // UNIQUE-conflict fallback read).
        const existing = await this.readClaim(client, decision.decisionId)
        if (existing) return this.checkReplay(existing, decision, successorInvocationId)
        // Expiry re-sampled INSIDE the write boundary: the insert can wait
        // on the slot, so validity is judged against now-after-the-wait.
        if (expiresAtTime !== null && expiresAtTime <= Date.now()) {
          return { status: 'rejected', reason: 'expired', detail: `decision expired at ${decision.expiresAt} (rechecked after write-slot wait)` }
        }
        const receipt: ConsumptionReceipt = {
          schema: CONSUMPTION_SCHEMA,
          receiptId: randomUUID(),
          decisionId: decision.decisionId,
          decisionDigest: decisionDigest(decision),
          decisionRequestId: decision.decisionRequestId,
          permittedAction: decision.permittedAction,
          successorInvocationId,
          claimedAt: new Date().toISOString(),
          claimNote: 'Claim acceptance does not prove invocation completion or exactly-once external effects.',
        }
        // The PK is the last line of defense for one-claim-per-decision
        // (mirrors the frozen store's UNIQUE-constraint path). A 23505 here
        // aborts this transaction; the catch below re-reads the winner on a
        // fresh connection after withClaimSlot rolls back.
        await client.query(
          'INSERT INTO consumption_receipts (decision_id, receipt_json, successor_invocation_id, decision_digest, claimed_at) VALUES ($1, $2, $3, $4, $5)',
          [receipt.decisionId, JSON.stringify(receipt, null, 2), receipt.successorInvocationId, receipt.decisionDigest, receipt.claimedAt],
        )
        return { status: 'claimed', receipt }
      })
    } catch (error) {
      // A 23505 escaping the slot body means the losing claimant's INSERT
      // aborted the transaction before the fallback could read; redo the
      // read on a clean connection (same outcome as the frozen fallback).
      if ((error as { code?: string }).code === '23505') {
        const winner = await this.readClaim(this.pool, decision.decisionId)
        if (!winner) throw new Error('claim conflict without durable winner')
        return this.checkReplay(winner, decision, successorInvocationId)
      }
      throw error
    }
  }

  /** Not part of the ReceiptStore seam; provided for tests and parity with
   * ConsumptionStore.getReceipt. */
  async getReceipt(decisionId: string): Promise<ConsumptionReceipt | undefined> {
    const result = await this.pool.query('SELECT receipt_json FROM consumption_receipts WHERE decision_id = $1', [decisionId])
    const row = result.rows[0] as { receipt_json: string } | undefined
    return row ? (JSON.parse(row.receipt_json) as ConsumptionReceipt) : undefined
  }

  async close(): Promise<void> {
    // Idempotent (pg-pool throws on a second end); see pg-run-store.close.
    this.closed ??= this.pool.end()
    await this.closed
  }
}
