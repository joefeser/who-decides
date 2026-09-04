/* SQLite RunStore adapter: every query moved verbatim from the engine
 * (tenant scoping, WAL, in-place ALTERs included). Methods are async to
 * satisfy the seam; the underlying better-sqlite3 calls are synchronous —
 * intentional and documented in store.ts. */
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

  async withWriteSlot<T>(fn: () => Promise<T>): Promise<T> {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = await fn()
      this.db.exec('COMMIT')
      return result
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
      .run(run.id, 'running', run.tenantId, run.invocationA, run.startedAt, run.phaseChangedAt, run.milestonesJson)
  }

  async updateRunPhase(runId: string, state: string, phaseChangedAt: string, completedAt?: string): Promise<void> {
    if (completedAt !== undefined) {
      this.db.prepare('UPDATE runs SET state = ?, phase_changed_at = ?, completed_at = ? WHERE id = ?')
        .run(state, phaseChangedAt, completedAt, runId)
    } else {
      this.db.prepare('UPDATE runs SET state = ?, phase_changed_at = ? WHERE id = ?')
        .run(state, phaseChangedAt, runId)
    }
  }

  async getDecisionIntent(runId: string): Promise<DecisionIntentRow | undefined> {
    return this.db.prepare('SELECT decision_json, invocation_b FROM runs WHERE id = ?').get(runId) as DecisionIntentRow | undefined
  }

  async persistDecisionIntent(runId: string, invocationB: string, decisionJson: string): Promise<void> {
    this.db
      .prepare('UPDATE runs SET invocation_b = ?, decision_json = ? WHERE id = ? AND decision_json IS NULL')
      .run(invocationB, decisionJson, runId)
  }

  async finalizeDecision(runId: string, state: string, phaseChangedAt: string, receiptJson: string, effectJson: string): Promise<void> {
    this.db
      .prepare('UPDATE runs SET state = ?, phase_changed_at = ?, receipt_json = ?, effect_json = ? WHERE id = ?')
      .run(state, phaseChangedAt, receiptJson, effectJson, runId)
  }

  async storeArtifact(artifact: StoredArtifact): Promise<void> {
    this.db
      .prepare('INSERT OR REPLACE INTO artifacts (run_id, tenant_id, name, kind, valid, json) VALUES (?, ?, ?, ?, ?, ?)')
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
    this.db.prepare('UPDATE runs SET replay_json = ? WHERE id = ?').run(replayJson, runId)
  }

  async archiveTenantRuns(tenantId: string): Promise<void> {
    this.db.prepare('UPDATE runs SET archived = 1 WHERE tenant_id = ?').run(tenantId)
  }

  async close(): Promise<void> {
    this.db.close()
  }
}
