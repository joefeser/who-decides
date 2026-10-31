/* SQLite RunStore adapter. Every query is the one moved verbatim from the
 * engine (tenant scoping, WAL, in-place ALTERs included). Methods are async
 * to satisfy the seam; the underlying better-sqlite3 calls are synchronous —
 * intentional and documented in store.ts.
 *
 * CRITICAL invariant: transaction bodies here are fully SYNCHRONOUS. An
 * await inside an open SQLite transaction yields the microtask queue, and a
 * second connection's blocking better-sqlite3 call can then stall the thread
 * so the holder never commits (deadlock -> database is locked), or re-enter
 * BEGIN on the same connection (nested transaction). Composite atomic
 * operations (ensureActiveRun, acquireDecisionIntent) therefore run as
 * synchronous BEGIN IMMEDIATE..COMMIT blocks with zero awaits — the exact
 * pattern the pre-seam engine used. A future Postgres adapter gets real
 * async transactions instead; that is why composite atomicity lives in the
 * adapter rather than the interface. */
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import type { RunStore, RunRow, NewRun, StoredArtifact, ArtifactRow, DecisionIntentRow, FullRunRow, NewOutboxOp, OutboxOpRow } from './store'

export class SqliteRunStore implements RunStore {
  private readonly db: Database.Database

  constructor(dir: string, dbFilename = 'state.db') {
    mkdirSync(dir, { recursive: true })
    this.db = new Database(path.join(dir, dbFilename))
    this.db.pragma('journal_mode = WAL')
  }

  async initialize(): Promise<void> {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        tenant_id TEXT NOT NULL DEFAULT 'default',
        invocation_a TEXT,
        invocation_b TEXT,
        started_at TEXT,
        completed_at TEXT,
        phase_changed_at TEXT NOT NULL,
        decision_json TEXT,
        receipt_json TEXT,
        effect_json TEXT,
        replay_json TEXT,
        milestones_json TEXT,
        run_kind TEXT NOT NULL DEFAULT 'native',
        archived INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS artifacts (
        run_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL DEFAULT 'default',
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        valid INTEGER NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY (run_id, name)
      );
      CREATE TABLE IF NOT EXISTS outbox_ops (
        run_id TEXT NOT NULL,
        op_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        target_system TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        result_json TEXT,
        created_at TEXT NOT NULL,
        dispatched_at TEXT,
        resolved_at TEXT,
        claim_owner TEXT,
        claimed_at TEXT,
        PRIMARY KEY (run_id, op_key)
      );
    `)
    try { this.db.exec("ALTER TABLE runs ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'deterministic'") } catch { /* column exists */ }
    try { this.db.exec("ALTER TABLE runs ADD COLUMN run_kind TEXT NOT NULL DEFAULT 'native'") } catch { /* column exists */ }
    // Pre-column databases (dev .tmp): add the columns in place.
    try { this.db.exec("ALTER TABLE runs ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default'") } catch { /* column exists */ }
    try { this.db.exec("ALTER TABLE outbox_ops ADD COLUMN claim_owner TEXT") } catch { /* column exists */ }
    try { this.db.exec("ALTER TABLE outbox_ops ADD COLUMN claimed_at TEXT") } catch { /* column exists */ }
    try { this.db.exec("ALTER TABLE artifacts ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default'") } catch { /* column exists */ }
    try { this.db.exec('ALTER TABLE runs ADD COLUMN archived INTEGER NOT NULL DEFAULT 0') } catch { /* column exists */ }
  }

  async ensureActiveRun(tenantId: string, candidate: NewRun): Promise<RunRow> {
    // One-active-run enforced inside a synchronous immediate transaction: a
    // concurrent caller cannot slip a second active run between check and
    // insert, and nothing awaits while the transaction is open.
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const existing = this.db
        .prepare('SELECT id, state, phase_changed_at, execution_mode, run_kind FROM runs WHERE archived = 0 AND tenant_id = ? ORDER BY started_at DESC LIMIT 1')
        .get(tenantId) as RunRow | undefined
      if (existing && existing.state !== 'completed') {
        this.db.exec('COMMIT')
        return existing
      }
      this.db
        .prepare('INSERT INTO runs (id, state, tenant_id, invocation_a, started_at, phase_changed_at, milestones_json, execution_mode, run_kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(candidate.id, 'provisioning', candidate.tenantId, candidate.invocationA, candidate.startedAt, candidate.phaseChangedAt, candidate.milestonesJson, candidate.executionMode ?? 'deterministic', candidate.runKind ?? 'native')
      this.db.exec('COMMIT')
      return { id: candidate.id, state: 'provisioning', phase_changed_at: candidate.phaseChangedAt, execution_mode: candidate.executionMode ?? 'deterministic', run_kind: candidate.runKind ?? 'native' }
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  async acquireDecisionIntent(runId: string, invocationB: string, decisionJson: string, outboxOp?: NewOutboxOp): Promise<DecisionIntentRow> {
    // Atomic first-writer-wins, synchronous body (see file header). The
    // outbox op (when supplied) commits in the SAME immediate transaction —
    // A2's one-transaction rule: decision intent and dispatch intent commit
    // together or not at all.
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const existing = this.db.prepare('SELECT decision_json, invocation_b FROM runs WHERE id = ? AND archived = 0').get(runId) as DecisionIntentRow | undefined
      if (!existing) {
        this.db.exec('COMMIT')
        return { decision_json: null, invocation_b: null }
      }
      if (existing.decision_json) {
        this.db.exec('COMMIT')
        return existing
      }
      this.db
        .prepare('UPDATE runs SET invocation_b = ?, decision_json = ? WHERE id = ? AND decision_json IS NULL AND archived = 0')
        .run(invocationB, decisionJson, runId)
      if (outboxOp) {
        // Same-key conflict is a no-op: only the intent winner reaches here,
        // and a repairing retry after a crashed caller re-derives the same
        // deterministic op — never a duplicate enqueue.
        this.db
          .prepare('INSERT INTO outbox_ops (run_id, op_key, kind, target_system, payload_json, status, created_at) VALUES (?, ?, ?, ?, ?, \'pending\', ?) ON CONFLICT(run_id, op_key) DO NOTHING')
          .run(outboxOp.runId, outboxOp.opKey, outboxOp.kind, outboxOp.targetSystem, outboxOp.payloadJson, new Date().toISOString())
      }
      this.db.exec('COMMIT')
      return { decision_json: decisionJson, invocation_b: invocationB }
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  async getOutboxOps(runId: string): Promise<OutboxOpRow[]> {
    return this.db
      .prepare('SELECT run_id, op_key, kind, target_system, payload_json, status, result_json, created_at, dispatched_at, resolved_at, claim_owner FROM outbox_ops WHERE run_id = ? ORDER BY created_at, rowid')
      .all(runId) as OutboxOpRow[]
  }

  async claimOutboxAttempt(runId: string, opKey: string, owner: string, claimedAt: string, force = false): Promise<boolean> {
    // One immediate transaction: the claim is durable in the shared store,
    // so a second instance (or process) sharing this database cannot enter
    // the transport beside a live attempt. Force takes an abandoned claim —
    // the explicit crash-recovery verb, never a guess about liveness.
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const changes = this.db
        .prepare(`UPDATE outbox_ops
                  SET status = 'dispatched', dispatched_at = COALESCE(dispatched_at, ?), claim_owner = ?, claimed_at = ?
                  WHERE run_id = ? AND op_key = ? AND status IN ('pending', 'dispatched', 'unknown')
                    AND (claim_owner IS NULL OR claim_owner = ?${force ? ' OR 1 = 1' : ''})`)
        .run(claimedAt, owner, claimedAt, runId, opKey, owner).changes
      this.db.exec('COMMIT')
      return changes > 0
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  async resolveOutboxOp(runId: string, opKey: string, status: 'confirmed' | 'unknown' | 'failed', resultJson: string, resolvedAt: string): Promise<boolean> {
    // Unknown -> terminal is legal (a retry's explicit receiver response is
    // evidence); pending never resolves; terminal rows are immutable.
    const result = this.db
      .prepare("UPDATE outbox_ops SET status = ?, result_json = ?, resolved_at = ?, claim_owner = NULL, claimed_at = NULL WHERE run_id = ? AND op_key = ? AND status IN ('dispatched', 'unknown')")
      .run(status, resultJson, resolvedAt, runId, opKey)
    return result.changes > 0
  }

  async getCurrentRun(tenantId: string): Promise<RunRow | undefined> {
    return this.db
      .prepare('SELECT id, state, phase_changed_at, execution_mode, run_kind FROM runs WHERE archived = 0 AND tenant_id = ? ORDER BY started_at DESC LIMIT 1')
      .get(tenantId) as RunRow | undefined
  }

  async insertRun(run: NewRun): Promise<void> {
    this.db
      .prepare('INSERT INTO runs (id, state, tenant_id, invocation_a, started_at, phase_changed_at, milestones_json, execution_mode, run_kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(run.id, 'provisioning', run.tenantId, run.invocationA, run.startedAt, run.phaseChangedAt, run.milestonesJson, run.executionMode ?? 'deterministic', run.runKind ?? 'native')
  }

  async markProvisioned(runId: string): Promise<boolean> {
    // The phase clock restarts here: provisioning is not part of the visible
    // running phase, so a slow provider must not eat into the 2.6s the UI
    // spends showing "running" (review P2).
    const result = this.db
      .prepare("UPDATE runs SET state = 'running', phase_changed_at = ? WHERE id = ? AND state = 'provisioning' AND archived = 0")
      .run(new Date().toISOString(), runId)
    return result.changes > 0
  }

  async updateRunPhase(runId: string, expectedState: string, state: string, phaseChangedAt: string, completedAt?: string): Promise<boolean> {
    // Live rows only: a reset that archives between the caller's read and
    // this CAS must win — archived audit rows are never mutated (review P2).
    const result = completedAt !== undefined
      ? this.db.prepare('UPDATE runs SET state = ?, phase_changed_at = ?, completed_at = ? WHERE id = ? AND state = ? AND archived = 0')
        .run(state, phaseChangedAt, completedAt, runId, expectedState)
      : this.db.prepare('UPDATE runs SET state = ?, phase_changed_at = ? WHERE id = ? AND state = ? AND archived = 0')
        .run(state, phaseChangedAt, runId, expectedState)
    return result.changes > 0
  }

  async getDecisionIntent(runId: string): Promise<DecisionIntentRow | undefined> {
    return this.db.prepare('SELECT decision_json, invocation_b FROM runs WHERE id = ?').get(runId) as DecisionIntentRow | undefined
  }

  async finalizeDecision(runId: string, expectedState: string, state: string, phaseChangedAt: string, receiptJson: string, effectJson: string): Promise<boolean> {
    const result = this.db
      .prepare("UPDATE runs SET state = ?, phase_changed_at = ?, receipt_json = ?, effect_json = ?, completed_at = CASE WHEN ? = 'completed' THEN ? ELSE completed_at END WHERE id = ? AND state = ? AND archived = 0")
      .run(state, phaseChangedAt, receiptJson, effectJson, state, phaseChangedAt, runId, expectedState)
    return result.changes > 0
  }

  async storeArtifact(artifact: StoredArtifact): Promise<void> {
    // First-writer-wins: committed audit artifacts are immutable. A slower
    // duplicate submission (whose builders may stamp different NOW() times)
    // must never replace the winner's evidence (review P2). Missing
    // artifacts — e.g. provisioning repair — still insert normally.
    this.db
      .prepare('INSERT INTO artifacts (run_id, tenant_id, name, kind, valid, json) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(run_id, name) DO NOTHING')
      .run(artifact.runId, artifact.tenantId, artifact.name, artifact.kind, artifact.valid ? 1 : 0, artifact.json)
  }

  async listArtifacts(runId: string, tenantId: string): Promise<ArtifactRow[]> {
    return this.db
      .prepare('SELECT name, kind, valid FROM artifacts WHERE run_id = ? AND tenant_id = ? ORDER BY rowid')
      .all(runId, tenantId) as ArtifactRow[]
  }

  async getRunRow(runId: string): Promise<FullRunRow | undefined> {
    return this.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as FullRunRow | undefined
  }

  async getArtifactJson(runId: string, name: string): Promise<string | undefined> {
    const row = this.db.prepare('SELECT json FROM artifacts WHERE run_id = ? AND name = ?').get(runId, name) as { json: string } | undefined
    return row?.json
  }

  async persistReplayProbe(runId: string, replayJson: string): Promise<void> {
    this.db.prepare('UPDATE runs SET replay_json = ? WHERE id = ? AND archived = 0').run(replayJson, runId)
  }

  async archiveTenantRuns(tenantId: string): Promise<void> {
    this.db.transaction(() => {
      // A resuming AgentCore run blocks reset only while its confirmation
      // artifact exists: a run stuck resuming with NO agent-resume artifact
      // (dispatch hung, or the confirmation could not be persisted through
      // a sustained outage) has no repair evidence — reset is its only
      // recovery, and keeping it blocked forever wedges the console.
      const pending = this.db.prepare("SELECT 1 FROM runs WHERE tenant_id = ? AND archived = 0 AND decision_json IS NOT NULL AND (state = 'decision_required' OR (state = 'resuming' AND execution_mode = 'agentcore' AND EXISTS (SELECT 1 FROM artifacts WHERE run_id = runs.id AND name = 'agent-resume')))").get(tenantId)
      if (pending) throw new Error('DECISION_IN_PROGRESS')
      // The bridge guard rides the SAME transaction: a decision committing
      // between a separate check and this archive would strand its outbound
      // obligation behind RUN_CHANGED.
      const unresolved = this.db.prepare("SELECT 1 FROM outbox_ops o JOIN runs r ON r.id = o.run_id WHERE r.tenant_id = ? AND r.archived = 0 AND r.run_kind = 'bridge' AND o.status IN ('pending', 'dispatched', 'unknown') LIMIT 1").get(tenantId)
      if (unresolved) throw new Error('BRIDGE_OPS_UNRESOLVED')
      this.db.prepare('UPDATE runs SET archived = 1 WHERE tenant_id = ?').run(tenantId)
    }).immediate()
  }

  async retractProvisioningRun(runId: string): Promise<boolean> {
    const result = this.db
      .prepare("UPDATE runs SET archived = 1 WHERE id = ? AND state = 'provisioning' AND archived = 0")
      .run(runId)
    return result.changes > 0
  }

  async close(): Promise<void> {
    this.db.close()
  }
}
