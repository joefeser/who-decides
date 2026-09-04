/* ReceiptStore seam: wraps the review-hardened ConsumptionStore (PRs #1/#4,
 * contention-proofed) without changing a line of it. Claim semantics, the
 * domain-separated digest, the BEGIN IMMEDIATE expiry recheck, and the
 * UNIQUE-conflict fallback are FROZEN — the Postgres adapter for the hosted
 * demo must reproduce them, not reinterpret them. */
import { ConsumptionStore } from '../../consumption/store'
import type { DecisionRecord, ClaimResult } from '../../consumption/store'

export interface ReceiptStore {
  claim(decision: DecisionRecord, successorInvocationId: string, expectedDigest?: string): Promise<ClaimResult>
  close(): Promise<void>
}

export class SqliteReceiptStore implements ReceiptStore {
  private readonly inner: ConsumptionStore

  constructor(dbPath: string) {
    this.inner = new ConsumptionStore(dbPath)
  }

  async claim(decision: DecisionRecord, successorInvocationId: string, expectedDigest?: string): Promise<ClaimResult> {
    return this.inner.claim(decision, successorInvocationId, expectedDigest)
  }

  async close(): Promise<void> {
    this.inner.close()
  }
}
