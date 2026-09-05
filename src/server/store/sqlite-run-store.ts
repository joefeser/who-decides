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
import type { RunStore, RunRow, NewRun, StoredArtifact, ArtifactRow, DecisionIntentRow, FullRunRow } from './store'

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
    `)
    // Pre-column databases (dev .tmp): add the columns in place.
    try { this.db.exec("ALTER TABLE runs ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default'") } catch { /* column exists */ }
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
        .prepare('SELECT id, state, phase_changed_at FROM runs WHERE archived = 0 AND tenant_id = ? ORDER BY started_at DESC LIMIT 1')
        .get(tenantId) as RunRow | undefined
      if (existing && existing.state !== 'completed') {
        this.db.exec('COMMIT')
        return existing
      }
      this.db
        .prepare('INSERT INTO runs (id, state, tenant_id, invocation_a, started_at, phase_changed_at, milestones_json) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(candidate.id, 'provisioning', candidate.tenantId, candidate.invocationA, candidate.startedAt, candidate.phaseChangedAt, candidate.milestonesJson)
      this.db.exec('COMMIT')
      return { id: candidate.id, state: 'provisioning', phase_changed_at: candidate.phaseChangedAt }
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  async acquireDecisionIntent(runId: string, invocationB: string, decisionJson: string): Promise<DecisionIntentRow> {
    // Atomic first-writer-wins, synchronous body (see file header).
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const existing = this.db.prepare('SELECT decision_json, invocation_b FROM runs WHERE id = ?').get(runId) as DecisionIntentRow | undefined
      if (existing?.decision_json) {
        this.db.exec('COMMIT')
        return existing
      }
      this.db
        .prepare('UPDATE runs SET invocation_b = ?, decision_json = ? WHERE id = ? AND decision_json IS NULL')
        .run(invocationB, decisionJson, runId)
      this.db.exec('COMMIT')
      return { decision_json: decisionJson, invocation_b: invocationB }
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  async getCurrentRun(tenantId: string): Promise<RunRow | undefined> {
    return this.db
      .prepare('SELECT id, state, phase_changed_at FROM runs WHERE archived = 0 AND tenant_id = ? ORDER BY started_at DESC LIMIT 1')
      .get(tenantId) as RunRow | undefined
  }

  async insertRun(run: NewRun): Promise<void> {
    this.db
      .prepare('INSERT INTO runs (id, state, tenant_id, invocation_a, started_at, phase_changed_at, milestones_json) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(run.id, 'provisioning', run.tenantId, run.invocationA, run.startedAt, run.phaseChangedAt, run.milestonesJson)
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
      .prepare('UPDATE runs SET state = ?, phase_changed_at = ?, receipt_json = ?, effect_json = ? WHERE id = ? AND state = ? AND archived = 0')
      .run(state, phaseChangedAt, receiptJson, effectJson, runId, expectedState)
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
    this.db.prepare('UPDATE runs SET archived = 1 WHERE tenant_id = ?').run(tenantId)
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
