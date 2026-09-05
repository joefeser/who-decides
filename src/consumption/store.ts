/* Consumption receipt — RULING M1/M2 + spike-log consumption design.
 *
 * A separate, immutable receipt that atomically binds one human decision to
 * exactly one successor invocation. The base decision record is never
 * mutated. SQLite provides the uniqueness + transaction guarantees; the
 * receipt is also emitted as a JSON artifact for the HACP pipeline.
 *
 * Honest scope (stated on every receipt): claim acceptance does NOT prove
 * invocation completion or exactly-once external effects.
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { LEGACY_CONSUMPTION_WRITER_VERSION, openAdmittedStore, rejectUnadmittedAccess, requireClosedWriterInventory, type StoreAdmission, type WriterAdmission } from '../store-admission'
import { CONSUMPTION_TABLE_SQL } from '../store-schema'

export const CONSUMPTION_SCHEMA = 'who-decides.consumption-receipt.v0'

export type DecisionRecord = {
  decisionId: string
  chosenOption: string
  rationale: string
  decidedAt: string
  decisionRequestId: string
  permittedAction: string
  expiresAt?: string
}

export type ConsumptionReceipt = {
  schema: typeof CONSUMPTION_SCHEMA
  receiptId: string
  decisionId: string
  decisionDigest: `sha256:${string}`
  decisionRequestId: string
  permittedAction: string
  successorInvocationId: string
  claimedAt: string
  claimNote: string
}

export type ClaimResult =
  | { status: 'claimed', receipt: ConsumptionReceipt }
  | { status: 'replayed', receipt: ConsumptionReceipt, note: string }
  | { status: 'rejected', reason: 'digest_mismatch' | 'invalid_expiry' | 'expired' | 'competing_successor' | 'profile_slot_conflict' | 'environment_blocked', detail: string }

export type ConsumptionStoreOptions = {
  admission?: StoreAdmission
  writer?: WriterAdmission
  test?: { beforeBeginImmediate?: () => void, afterBeginImmediate?: () => void }
}

/** Require a real RFC3339 calendar date, not Date.parse's rollover or
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

export function decisionDigest(decision: DecisionRecord): `sha256:${string}` {
  // Version the local digest encoding; historical receipts remain readable but
  // cannot prove expiry was absent (the old digest omitted it entirely).
  const canonical = JSON.stringify({
    digestDomain: 'who-decides.decision.v1',
    decisionId: decision.decisionId,
    chosenOption: decision.chosenOption,
    rationale: decision.rationale,
    decidedAt: decision.decidedAt,
    decisionRequestId: decision.decisionRequestId,
    permittedAction: decision.permittedAction,
    expiresAt: decision.expiresAt ?? null,
  })
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`
}

export class ConsumptionStore {
  private readonly db: Database.Database
  private readonly options: ConsumptionStoreOptions

  constructor(dbPath: string, options: ConsumptionStoreOptions = {}) {
    this.options = options
    if (options.admission) {
      const writer = { role: 'legacy-consumption-writer', version: LEGACY_CONSUMPTION_WRITER_VERSION, insertionPath: 'ConsumptionStore.claim' }
      if (options.writer && (options.writer.role !== writer.role || options.writer.version !== writer.version || options.writer.insertionPath !== writer.insertionPath)) {
        throw new Error('OWNER_STORE_ADMISSION_FAILED: writer identity is unapproved for this implementation')
      }
      this.db = openAdmittedStore(dbPath, options.admission, writer)
    } else {
      mkdirSync(path.dirname(dbPath), { recursive: true })
      this.db = new Database(dbPath)
      try { rejectUnadmittedAccess(this.db) }
      catch (error) { this.db.close(); throw error }
      this.db.pragma('journal_mode = WAL')
    }
    this.db.exec(CONSUMPTION_TABLE_SQL)
  }

  /** Atomic claim. Exactly one successor invocation can ever succeed per decision. */
  claim(decision: DecisionRecord, successorInvocationId: string, expectedDigest?: string): ClaimResult {
    if (this.options.admission) {
      try { requireClosedWriterInventory(this.db, this.options.admission) }
      catch { return { status: 'rejected', reason: 'environment_blocked', detail: 'owner-admitted writer inventory is unavailable or changed' } }
    }
    if (expectedDigest !== undefined && expectedDigest !== decisionDigest(decision)) {
      return { status: 'rejected', reason: 'digest_mismatch', detail: 'provided digest does not match the decision record' }
    }
    if (decision.expiresAt !== undefined) {
      const validity = validateExpiry(decision.expiresAt)
      if (!validity.ok) return { status: 'rejected', reason: 'invalid_expiry', detail: validity.detail }
      if (validity.time <= Date.now()) {
        return { status: 'rejected', reason: 'expired', detail: `decision expired at ${decision.expiresAt}` }
      }
    }

    const existing = this.readClaim(decision.decisionId)
    if (existing) return this.checkReplay(existing, decision, successorInvocationId)

    // No existing claim: acquire the write slot BEFORE constructing the
    // receipt. The insert can wait on another connection's write lock, so the
    // expiry is rechecked and claimedAt is stamped AFTER the wait, inside the
    // slot — the committed receipt then reflects the actual claim time and
    // never authorizes an already-expired decision (review P1).
    let expiresAtTime: number | null = null
    if (decision.expiresAt !== undefined) {
      const validity = validateExpiry(decision.expiresAt)
      if (!validity.ok) return { status: 'rejected', reason: 'invalid_expiry', detail: validity.detail }
      expiresAtTime = validity.time
    }
    const insert = this.db.prepare(
      'INSERT INTO consumption_receipts (decision_id, receipt_json, successor_invocation_id, decision_digest, claimed_at) VALUES (?, ?, ?, ?, ?)',
    )
    this.options.test?.beforeBeginImmediate?.()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.options.test?.afterBeginImmediate?.()
      if (this.options.admission) {
        try { requireClosedWriterInventory(this.db, this.options.admission) }
        catch {
          this.db.exec('ROLLBACK')
          return { status: 'rejected', reason: 'environment_blocked', detail: 'owner-admitted store or writer inventory changed before insertion' }
        }
      }
      const candidateTable = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='local_owner_slots'").get()
      if (candidateTable && this.db.prepare('SELECT 1 FROM local_owner_slots WHERE decision_id=?').get(decision.decisionId)) {
        this.db.exec('ROLLBACK')
        return { status: 'rejected', reason: 'profile_slot_conflict', detail: 'decision ID is already admitted by the local-owner candidate profile' }
      }
      if (expiresAtTime !== null && expiresAtTime <= Date.now()) {
        this.db.exec('ROLLBACK')
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
      insert.run(receipt.decisionId, JSON.stringify(receipt, null, 2), receipt.successorInvocationId, receipt.decisionDigest, receipt.claimedAt)
      this.db.exec('COMMIT')
      return { status: 'claimed', receipt }
    } catch (error) {
      if (this.db.inTransaction) this.db.exec('ROLLBACK')
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('UNIQUE constraint failed')) {
        const winner = this.readClaim(decision.decisionId)
        if (!winner) throw new Error('claim conflict without durable winner')
        return this.checkReplay(winner, decision, successorInvocationId)
      }
      throw error
    }
  }

  private readClaim(decisionId: string) {
    return this.db.prepare('SELECT receipt_json, successor_invocation_id, decision_digest FROM consumption_receipts WHERE decision_id = ?')
      .get(decisionId) as { receipt_json: string, successor_invocation_id: string, decision_digest: string } | undefined
  }

  private checkReplay(stored: NonNullable<ReturnType<ConsumptionStore['readClaim']>>, decision: DecisionRecord, successor: string): ClaimResult {
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

  getReceipt(decisionId: string): ConsumptionReceipt | undefined {
    const row = this.db
      .prepare('SELECT receipt_json FROM consumption_receipts WHERE decision_id = ?')
      .get(decisionId) as { receipt_json: string } | undefined
    return row ? (JSON.parse(row.receipt_json) as ConsumptionReceipt) : undefined
  }

  close(): void {
    this.db.close()
  }
}
