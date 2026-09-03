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
  | { status: 'rejected', reason: 'digest_mismatch' | 'expired' | 'competing_successor', detail: string }

export function decisionDigest(decision: DecisionRecord): `sha256:${string}` {
  const canonical = JSON.stringify({
    decisionId: decision.decisionId,
    chosenOption: decision.chosenOption,
    rationale: decision.rationale,
    decidedAt: decision.decidedAt,
    decisionRequestId: decision.decisionRequestId,
    permittedAction: decision.permittedAction,
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
    if (decision.expiresAt !== undefined && Date.parse(decision.expiresAt) <= Date.now()) {
      return { status: 'rejected', reason: 'expired', detail: `decision expired at ${decision.expiresAt}` }
    }

    const existing = this.db
      .prepare('SELECT receipt_json, successor_invocation_id FROM consumption_receipts WHERE decision_id = ?')
      .get(decision.decisionId) as { receipt_json: string, successor_invocation_id: string } | undefined

    if (existing) {
      const receipt = JSON.parse(existing.receipt_json) as ConsumptionReceipt
      if (existing.successor_invocation_id === successorInvocationId) {
        return { status: 'replayed', receipt, note: 'identical successor retry — original claim stands (recovery preserves the binding)' }
      }
      return {
        status: 'rejected',
        reason: 'competing_successor',
        detail: `decision already claimed by invocation ${existing.successor_invocation_id} at ${receipt.claimedAt}`,
      }
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

    const insert = this.db.prepare(
      'INSERT INTO consumption_receipts (decision_id, receipt_json, successor_invocation_id, decision_digest, claimed_at) VALUES (?, ?, ?, ?, ?)',
    )
    try {
      insert.run(receipt.decisionId, JSON.stringify(receipt, null, 2), receipt.successorInvocationId, receipt.decisionDigest, receipt.claimedAt)
      return { status: 'claimed', receipt }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('UNIQUE constraint failed')) {
        const winner = this.db
          .prepare('SELECT receipt_json, successor_invocation_id FROM consumption_receipts WHERE decision_id = ?')
          .get(decision.decisionId) as { receipt_json: string, successor_invocation_id: string }
        const winnerReceipt = JSON.parse(winner.receipt_json) as ConsumptionReceipt
        if (winner.successor_invocation_id === successorInvocationId) {
          return { status: 'replayed', receipt: winnerReceipt, note: 'race lost to ourselves — original claim stands' }
        }
        return {
          status: 'rejected',
          reason: 'competing_successor',
          detail: `lost the race to invocation ${winner.successor_invocation_id}`,
        }
      }
      throw error
    }
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
