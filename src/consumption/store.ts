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
  | { status: 'rejected', reason: 'digest_mismatch' | 'invalid_expiry' | 'expired' | 'competing_successor', detail: string }

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

  constructor(dbPath: string) {
    mkdirSync(path.dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS consumption_receipts (
        decision_id TEXT PRIMARY KEY,
        receipt_json TEXT NOT NULL,
        successor_invocation_id TEXT NOT NULL,
        decision_digest TEXT NOT NULL,
        claimed_at TEXT NOT NULL
      )
    `)
  }

  /** Atomic claim. Exactly one successor invocation can ever succeed per decision. */
  claim(decision: DecisionRecord, successorInvocationId: string, expectedDigest?: string): ClaimResult {
    if (expectedDigest !== undefined && expectedDigest !== decisionDigest(decision)) {
      return { status: 'rejected', reason: 'digest_mismatch', detail: 'provided digest does not match the decision record' }
    }
    if (decision.expiresAt !== undefined) {
      // Require a real RFC3339 calendar date, not Date.parse's rollover or
      // locale-dependent shortcuts. Fractional seconds and explicit offsets
      // are supported; leap seconds are not supported by this local runtime.
      const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/.exec(decision.expiresAt)
      const time = Date.parse(decision.expiresAt)
      const year = match ? Number(match[1]) : 0
      const month = match ? Number(match[2]) : 0
      const day = match ? Number(match[3]) : 0
      const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
      const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
      if (!match || !Number.isFinite(time) || month < 1 || month > 12 || day < 1 || day > days[month - 1]
        || Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59
        || Number(match[8] ?? 0) > 23 || Number(match[9] ?? 0) > 59) {
        return { status: 'rejected', reason: 'invalid_expiry', detail: 'expiry must be a valid RFC3339 timestamp' }
      }
      if (time <= Date.now()) {
        return { status: 'rejected', reason: 'expired', detail: `decision expired at ${decision.expiresAt}` }
      }
    }

    const existing = this.readClaim(decision.decisionId)
    if (existing) return this.checkReplay(existing, decision, successorInvocationId)

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

    const insert = this.db.prepare(
      'INSERT INTO consumption_receipts (decision_id, receipt_json, successor_invocation_id, decision_digest, claimed_at) VALUES (?, ?, ?, ?, ?)',
    )
    try {
      insert.run(receipt.decisionId, JSON.stringify(receipt, null, 2), receipt.successorInvocationId, receipt.decisionDigest, receipt.claimedAt)
      return { status: 'claimed', receipt }
    } catch (error) {
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
