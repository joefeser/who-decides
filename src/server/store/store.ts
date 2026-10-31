/* Storage provider seam (PR2): the console engine talks to these async
 * interfaces instead of a database directly. SQLite is the default adapter
 * (zero-config local demo); a Postgres adapter for the hosted demo can be
 * added later without touching engine logic.
 *
 * Interfaces are async EVEN THOUGH the SQLite adapter executes synchronously
 * underneath: `pg` (and every network database) is async, so the seam must
 * be async from day one or the Postgres adapter would force an engine
 * rewrite. The sync-bridge cost is irrelevant at demo scale. */

export type RunRow = {
  id: string
  state: string
  execution_mode?: string
  /** 'native' (fixture scenario) | 'bridge' (external decision request). */
  run_kind?: string
  phase_changed_at: string
}

export type FullRunRow = Record<string, string | null>

export type DecisionIntentRow = { decision_json: string | null, invocation_b: string | null }

/* Outbox (A2): one row per outbound operation. The payload is persisted at
 * ENQUEUE time, inside the same adapter transaction as the decision intent
 * — the one-transaction rule — and the dispatcher may only ever replay these
 * exact bytes. resultJson is the per-op result row: the receiver's response
 * when confirmed, the typed error when failed, or an explicit
 * outcome-unknown marker that is retained (never guessed up or down). */
export type OutboxOpKind = 'answer' | 'approve'

export type OutboxOpStatus = 'pending' | 'dispatched' | 'confirmed' | 'unknown' | 'failed'

export type NewOutboxOp = {
  runId: string
  /** Receiver-side idempotency key (B4 replays the original result on an
   * identical retry). Deterministic per (run, operation) so recovery
   * reuses it without re-derivation. */
  opKey: string
  kind: OutboxOpKind
  targetSystem: string
  payloadJson: string
}

/** Read shape — snake_case columns, matching the other read rows
 * (RunRow/DecisionIntentRow) both adapters return. */
export type OutboxOpRow = {
  run_id: string
  op_key: string
  kind: OutboxOpKind
  target_system: string
  payload_json: string
  status: OutboxOpStatus
  result_json: string | null
  created_at: string
  dispatched_at: string | null
  resolved_at: string | null
}

export type ArtifactRow = { name: string, kind: string, valid: number }

export type NewRun = {
  /** Runs are inserted as 'provisioning' and flip to 'running' via
   * markProvisioned once invocation-A artifacts are durable. */
  id: string
  tenantId: string
  /** Native runs mint an invocation A; bridge runs have none (null). */
  invocationA: string | null
  startedAt: string
  phaseChangedAt: string
  executionMode?: string
  /** 'native' (default) | 'bridge' — selects the intake path; a bridge run's
   * decision request comes from the persisted envelope, never the fixture. */
  runKind?: 'native' | 'bridge'
  milestonesJson: string
}

export type StoredArtifact = {
  runId: string
  tenantId: string
  name: string
  kind: string
  valid: boolean
  json: string
}

export interface RunStore {
  /** Ensure schema exists (idempotent). Adapter-owned migrations live here. */
  initialize(): Promise<void>
  /** Atomic check-then-act: returns the tenant's active (non-completed) run,
   * inserting the candidate only when none exists. Composite atomicity lives
   * INSIDE adapters — SQLite via a synchronous BEGIN IMMEDIATE block, a
   * future Postgres adapter via a real transaction — because a public
   * transaction seam cannot guarantee its callback's statements execute on
   * the same connection (review finding). */
  ensureActiveRun(tenantId: string, candidate: NewRun): Promise<RunRow>
  getCurrentRun(tenantId: string): Promise<RunRow | undefined>
  insertRun(run: NewRun): Promise<void>
  /** Compare-and-swap phase transition: applies only when the run is still
   * in `expectedState` (a stale poller must never overwrite a newer phase —
   * e.g. flipping a consumed run back to decision_required). Returns whether
   * the transition applied. */
  updateRunPhase(runId: string, expectedState: string, state: string, phaseChangedAt: string, completedAt?: string): Promise<boolean>
  /** CAS completion of provisioning: provisioning -> running, only while
   * the run is live (not archived). False means the run was retracted. */
  markProvisioned(runId: string): Promise<boolean>
  getDecisionIntent(runId: string): Promise<DecisionIntentRow | undefined>
  /** Atomic first-writer-wins intent acquisition: inside the exclusive write
   * slot, persists (successor, decisionJson) only if none exists and returns
   * the STORED intent — a losing concurrent submission receives the winner's
   * successor and decision, never its own stale values. A missing/archived
   * row returns null fields; it cannot authorize a claim.
   *
   * A2's one-transaction rule: when outboxOp is supplied, the outbound op
   * row commits INSIDE this same adapter transaction — a recorded decision
   * can never exist without its dispatch intent, and neither can commit
   * alone. The op insert is idempotent (same-key conflict is a no-op) so a
   * repairing retry after a crashed caller never double-enqueues. */
  acquireDecisionIntent(runId: string, invocationB: string, decisionJson: string, outboxOp?: NewOutboxOp): Promise<DecisionIntentRow>
  /** Outbox ops for a run in enqueue (creation) order. */
  getOutboxOps(runId: string): Promise<OutboxOpRow[]>
  /** CAS pending -> dispatched: exactly one dispatcher owns an op's wire
   * attempt. False = already dispatched (or terminal/missing). */
  markOutboxDispatched(runId: string, opKey: string, dispatchedAt: string): Promise<boolean>
  /** Per-op result row. Legal transitions: dispatched -> terminal,
   * unknown -> terminal (an explicit receiver response on a retry is
   * evidence, not a guess). Pending ops never resolve; terminal ops are
   * immutable. */
  resolveOutboxOp(runId: string, opKey: string, status: 'confirmed' | 'unknown' | 'failed', resultJson: string, resolvedAt: string): Promise<boolean>
  /** CAS finalization (decision_required -> resuming): a slower duplicate
   * submission must never drag an already-completed run back to resuming.
   * False means the run already moved on — idempotent success for callers. */
  finalizeDecision(runId: string, expectedState: string, state: string, phaseChangedAt: string, receiptJson: string, effectJson: string): Promise<boolean>
  /** Persists an artifact FIRST-WRITER-WINS: committed audit artifacts are
   * immutable — a later writer with the same (runId, name) is a no-op. */
  storeArtifact(artifact: StoredArtifact): Promise<void>
  listArtifacts(runId: string, tenantId: string): Promise<ArtifactRow[]>
  getRunRow(runId: string): Promise<FullRunRow | undefined>
  getArtifactJson(runId: string, name: string): Promise<string | undefined>
  persistReplayProbe(runId: string, replayJson: string): Promise<void>
  archiveTenantRuns(tenantId: string): Promise<void>
  /** Retracts a run still in the provisioning state — the state machine,
   * not artifact-existence guessing, decides (a concurrent repair flips the
   * run to running via markProvisioned first and survives retraction). */
  retractProvisioningRun(runId: string): Promise<boolean>
  close(): Promise<void>
}

export type OperatorSessionRow = {
  token_hash: string
  created_at: string
  expires_at: string
  /** Fingerprint of the passcode config the session was issued under —
   * rotating the passcode invalidates rows with a different fingerprint.
   * NULL means a pre-fingerprinting row, which validates as NOT
   * authenticated (fail closed). */
  passcode_fingerprint: string | null
}

/** Operator session persistence for the passcode gate (same async seam as
 * RunStore — same Postgres-adapter rationale). ONLY sha256 token hashes are
 * stored here; the raw token lives solely in the operator's cookie. */
export interface SessionStore {
  /** Ensure schema exists (idempotent). Adapter-owned migrations live here. */
  initialize(): Promise<void>
  createSession(tokenHash: string, createdAt: string, expiresAt: string, passcodeFingerprint: string): Promise<void>
  getSession(tokenHash: string): Promise<OperatorSessionRow | undefined>
  revokeSession(tokenHash: string): Promise<void>
  /** Best-effort tidy: drop sessions that expired at or before nowIso. */
  purgeExpiredSessions(nowIso: string): Promise<void>
  close(): Promise<void>
}
