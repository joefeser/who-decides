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
  /** Exclusive write slot covering a check-then-act sequence. We use a
   * callback (not begin/commit pairs) because it maps directly onto both
   * SQLite BEGIN IMMEDIATE and Postgres BEGIN...COMMIT without leaking
   * transaction state across awaits to callers. */
  withWriteSlot<T>(fn: () => Promise<T>): Promise<T>
  getCurrentRun(tenantId: string): Promise<RunRow | undefined>
  insertRun(run: NewRun): Promise<void>
  updateRunPhase(runId: string, state: string, phaseChangedAt: string, completedAt?: string): Promise<void>
  getDecisionIntent(runId: string): Promise<DecisionIntentRow | undefined>
  /** Atomic first-writer-wins intent acquisition: inside the exclusive write
   * slot, persists (successor, decisionJson) only if none exists and returns
   * the STORED intent — a losing concurrent submission receives the winner's
   * successor and decision, never its own stale values. */
  acquireDecisionIntent(runId: string, invocationB: string, decisionJson: string): Promise<DecisionIntentRow>
  finalizeDecision(runId: string, state: string, phaseChangedAt: string, receiptJson: string, effectJson: string): Promise<void>
  storeArtifact(artifact: StoredArtifact): Promise<void>
  listArtifacts(runId: string, tenantId: string): Promise<ArtifactRow[]>
  getRunRow(runId: string): Promise<FullRunRow | undefined>
  getArtifactJson(runId: string, name: string): Promise<string | undefined>
  persistReplayProbe(runId: string, replayJson: string): Promise<void>
  archiveTenantRuns(tenantId: string): Promise<void>
  close(): Promise<void>
}
