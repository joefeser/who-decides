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
  phase_changed_at: string
}

export type FullRunRow = Record<string, string | null>

export type DecisionIntentRow = { decision_json: string | null, invocation_b: string | null }

export type ArtifactRow = { name: string, kind: string, valid: number }

export type NewRun = {
  /** Runs are inserted as 'provisioning' and flip to 'running' via
   * markProvisioned once invocation-A artifacts are durable. */
  id: string
  tenantId: string
  invocationA: string
  startedAt: string
  phaseChangedAt: string
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
   * successor and decision, never its own stale values. */
  acquireDecisionIntent(runId: string, invocationB: string, decisionJson: string): Promise<DecisionIntentRow>
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
}

/** Operator session persistence for the passcode gate (same async seam as
 * RunStore — same Postgres-adapter rationale). ONLY sha256 token hashes are
 * stored here; the raw token lives solely in the operator's cookie. */
export interface SessionStore {
  /** Ensure schema exists (idempotent). Adapter-owned migrations live here. */
  initialize(): Promise<void>
  createSession(tokenHash: string, createdAt: string, expiresAt: string): Promise<void>
  getSession(tokenHash: string): Promise<OperatorSessionRow | undefined>
  revokeSession(tokenHash: string): Promise<void>
  /** Best-effort tidy: drop sessions that expired at or before nowIso. */
  purgeExpiredSessions(nowIso: string): Promise<void>
  close(): Promise<void>
}
