/* Postgres RunStore adapter (hosted demo). Same tables/columns/queries as the
 * SQLite adapter, translated to Postgres DDL and pg.Pool. Composite atomicity
 * lives INSIDE adapters by design (store.ts header): here that means real
 * async transactions with transaction-scoped advisory locks instead of the
 * synchronous BEGIN IMMEDIATE blocks.
 *
 * SEMANTIC CHOICE (conservative, PR-reviewed): ensureActiveRun serializes its
 * check-then-act with pg_advisory_xact_lock keyed on the tenant, mirroring
 * SQLite's BEGIN IMMEDIATE write-slot exactly — the loser waits, then sees
 * the winner's active run and returns it, never inserting a second one.
 * SELECT ... FOR UPDATE alone cannot do this (no row to lock when no active
 * run exists), and SERIALIZABLE would need a retry loop; the advisory lock
 * auto-releases at COMMIT/ROLLBACK so no lock-lizard cleanup is required.
 * acquireDecisionIntent needs no lock at all: a single
 * UPDATE ... WHERE decision_json IS NULL (returning whether it won) is
 * atomic under MVCC, and the loser re-reads the stored intent.
 *
 * The artifacts table adds a seq IDENTITY column: Postgres has no rowid, and
 * listArtifacts must return insertion order (the console renders the
 * timeline in write order, as SQLite's ORDER BY rowid does). */
import { Pool, type PoolClient } from 'pg'
import type { RunStore, RunRow, NewRun, StoredArtifact, ArtifactRow, DecisionIntentRow, FullRunRow } from './store'

/** Connection config: an explicit connectionString wins; otherwise the
 * WD_PG_URL / DATABASE_URL environment is used ONLY when the caller passed
 * no discrete fields (pg would let a connectionString override discrete
 * fields, so honoring the URL first could silently redirect an explicit
 * { host, database } to the ambient database); otherwise discrete fields,
 * then pg's own PG* env defaults. */
export type PostgresStoreConfig = {
  connectionString?: string
  host?: string
  port?: number
  user?: string
  password?: string
  database?: string
  /** Pool size per store instance. The engine holds one run store + one
   * receipt store; two pools of 5 covers the console and its tests. */
  max?: number
}

export function resolvePostgresConfig(overrides: PostgresStoreConfig = {}): PostgresStoreConfig {
  if (overrides.connectionString) {
    return { ...overrides, connectionString: overrides.connectionString }
  }
  const hasDiscrete = overrides.host !== undefined || overrides.port !== undefined
    || overrides.user !== undefined || overrides.password !== undefined || overrides.database !== undefined
  if (!hasDiscrete && (process.env.WD_PG_URL ?? process.env.DATABASE_URL)) {
    return { ...overrides, connectionString: process.env.WD_PG_URL ?? process.env.DATABASE_URL }
  }
  const host = overrides.host ?? process.env.WD_PG_HOST
  if (host) {
    return {
      ...overrides,
      host,
      port: overrides.port ?? (process.env.WD_PG_PORT ? Number(process.env.WD_PG_PORT) : undefined),
      user: overrides.user ?? process.env.WD_PG_USER,
      password: overrides.password ?? process.env.WD_PG_PASSWORD,
      database: overrides.database ?? process.env.WD_PG_DATABASE,
    }
  }
  return overrides
}

/** Advisory-lock class ids namespacing this app's locks so they cannot
 * collide with other advisory users in a shared cluster. LOCK_MIGRATE
 * (plain 0 member) serializes schema DDL; the receipt store shares it. */
const LOCK_ENSURE_ACTIVE = 7001
const LOCK_MIGRATE = 7003

export class PostgresRunStore implements RunStore {
  private readonly pool: Pool
  private closed: Promise<void> | undefined

  constructor(config: PostgresStoreConfig = {}) {
    const resolved = resolvePostgresConfig(config)
    this.pool = new Pool({ ...resolved, max: resolved.max ?? 5 })
  }

  async initialize(): Promise<void> {
    // Same tables/columns as sqlite-run-store's initialize(), Postgres DDL.
    // Additive in place: pre-column databases gain the columns without a
    // rewrite (Postgres supports ADD COLUMN IF NOT EXISTS). All DDL runs
    // under the shared database-wide migration lock (LOCK_MIGRATE): CREATE
    // TABLE IF NOT EXISTS is not race-free across concurrent first-starts,
    // and a lost catalog race would reject an engine's ready promise.
    await this.withTx(async client => {
      await client.query('SELECT pg_advisory_xact_lock($1, 0)', [LOCK_MIGRATE])
      await client.query(`
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
          seq BIGINT GENERATED ALWAYS AS IDENTITY,
          PRIMARY KEY (run_id, name)
        );
        ALTER TABLE runs ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';
        ALTER TABLE runs ADD COLUMN IF NOT EXISTS archived INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';
        -- Insertion order for pre-identity tables: backfills existing rows.
        ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS seq BIGINT GENERATED ALWAYS AS IDENTITY;
      `)
    })
  }

  /** Run `body` on one client inside a real transaction, rolling back on
   * any throw. This is the Postgres counterpart of the SQLite adapter's
   * synchronous BEGIN IMMEDIATE..COMMIT blocks — the only place composite
   * atomicity can be guaranteed for a network database (store.ts header). */
  private async withTx<T>(body: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const value = await body(client)
      await client.query('COMMIT')
      return value
    } catch (err) {
      try { await client.query('ROLLBACK') } catch { /* connection already broken */ }
      throw err
    } finally {
      client.release()
    }
  }

  async ensureActiveRun(tenantId: string, candidate: NewRun): Promise<RunRow> {
    return this.withTx(async client => {
      // One-active-run enforced inside the transaction: the tenant-scoped
      // advisory lock blocks a concurrent caller between check and insert
      // (equivalent of BEGIN IMMEDIATE; see file header for the choice).
      await client.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [LOCK_ENSURE_ACTIVE, tenantId])
      const existing = await client.query(
        'SELECT id, state, phase_changed_at FROM runs WHERE archived = 0 AND tenant_id = $1 ORDER BY started_at DESC LIMIT 1',
        [tenantId],
      )
      const active = existing.rows[0] as RunRow | undefined
      if (active && active.state !== 'completed') return active
      await client.query(
        'INSERT INTO runs (id, state, tenant_id, invocation_a, started_at, phase_changed_at, milestones_json) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [candidate.id, 'provisioning', candidate.tenantId, candidate.invocationA, candidate.startedAt, candidate.phaseChangedAt, candidate.milestonesJson],
      )
      return { id: candidate.id, state: 'provisioning', phase_changed_at: candidate.phaseChangedAt }
    })
  }

  async acquireDecisionIntent(runId: string, invocationB: string, decisionJson: string): Promise<DecisionIntentRow> {
    // Atomic first-writer-wins in a single statement: the winner's UPDATE
    // matches decision_json IS NULL; every loser's matches nothing and
    // re-reads the STORED intent (MVCC makes check-then-act one step).
    // Live rows only (invariant: archived rows are never mutated) — a reset
    // that archives between the caller's read and this write must not
    // persist an intent onto an archived audit row.
    const won = await this.pool.query(
      'UPDATE runs SET invocation_b = $2, decision_json = $3 WHERE id = $1 AND decision_json IS NULL AND archived = 0',
      [runId, invocationB, decisionJson],
    )
    if ((won.rowCount ?? 0) > 0) return { decision_json: decisionJson, invocation_b: invocationB }
    const stored = await this.pool.query('SELECT decision_json, invocation_b FROM runs WHERE id = $1', [runId])
    const row = stored.rows[0] as DecisionIntentRow | undefined
    if (row?.decision_json) return row
    // Row absent or intent still unset (cannot happen after a winning
    // UPDATE): preserve the SQLite adapter's return-the-intent contract.
    return { decision_json: decisionJson, invocation_b: invocationB }
  }

  async getCurrentRun(tenantId: string): Promise<RunRow | undefined> {
    const result = await this.pool.query(
      'SELECT id, state, phase_changed_at FROM runs WHERE archived = 0 AND tenant_id = $1 ORDER BY started_at DESC LIMIT 1',
      [tenantId],
    )
    return result.rows[0] as RunRow | undefined
  }

  async insertRun(run: NewRun): Promise<void> {
    await this.pool.query(
      'INSERT INTO runs (id, state, tenant_id, invocation_a, started_at, phase_changed_at, milestones_json) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [run.id, 'provisioning', run.tenantId, run.invocationA, run.startedAt, run.phaseChangedAt, run.milestonesJson],
    )
  }

  async markProvisioned(runId: string): Promise<boolean> {
    // Phase clock restarts on provisioning completion (see SQLite adapter).
    const result = await this.pool.query(
      "UPDATE runs SET state = 'running', phase_changed_at = $1 WHERE id = $2 AND state = 'provisioning' AND archived = 0",
      [new Date().toISOString(), runId],
    )
    return (result.rowCount ?? 0) > 0
  }

  async updateRunPhase(runId: string, expectedState: string, state: string, phaseChangedAt: string, completedAt?: string): Promise<boolean> {
    // CAS on the expected state, live rows only — a stale poller can never
    // overwrite a newer phase, and archived rows are never mutated.
    const result = completedAt !== undefined
      ? await this.pool.query(
          'UPDATE runs SET state = $1, phase_changed_at = $2, completed_at = $3 WHERE id = $4 AND state = $5 AND archived = 0',
          [state, phaseChangedAt, completedAt, runId, expectedState],
        )
      : await this.pool.query(
          'UPDATE runs SET state = $1, phase_changed_at = $2 WHERE id = $3 AND state = $4 AND archived = 0',
          [state, phaseChangedAt, runId, expectedState],
        )
    return (result.rowCount ?? 0) > 0
  }

  async getDecisionIntent(runId: string): Promise<DecisionIntentRow | undefined> {
    const result = await this.pool.query('SELECT decision_json, invocation_b FROM runs WHERE id = $1', [runId])
    return result.rows[0] as DecisionIntentRow | undefined
  }

  async finalizeDecision(runId: string, expectedState: string, state: string, phaseChangedAt: string, receiptJson: string, effectJson: string): Promise<boolean> {
    const result = await this.pool.query(
      'UPDATE runs SET state = $1, phase_changed_at = $2, receipt_json = $3, effect_json = $4 WHERE id = $5 AND state = $6 AND archived = 0',
      [state, phaseChangedAt, receiptJson, effectJson, runId, expectedState],
    )
    return (result.rowCount ?? 0) > 0
  }

  async storeArtifact(artifact: StoredArtifact): Promise<void> {
    // First-writer-wins: committed audit artifacts are immutable.
    await this.pool.query(
      'INSERT INTO artifacts (run_id, tenant_id, name, kind, valid, json) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (run_id, name) DO NOTHING',
      [artifact.runId, artifact.tenantId, artifact.name, artifact.kind, artifact.valid ? 1 : 0, artifact.json],
    )
  }

  async listArtifacts(runId: string, tenantId: string): Promise<ArtifactRow[]> {
    // ORDER BY seq = SQLite's ORDER BY rowid (insertion order).
    const result = await this.pool.query(
      'SELECT name, kind, valid FROM artifacts WHERE run_id = $1 AND tenant_id = $2 ORDER BY seq',
      [runId, tenantId],
    )
    return result.rows as ArtifactRow[]
  }

  async getRunRow(runId: string): Promise<FullRunRow | undefined> {
    const result = await this.pool.query('SELECT * FROM runs WHERE id = $1', [runId])
    return result.rows[0] as FullRunRow | undefined
  }

  async getArtifactJson(runId: string, name: string): Promise<string | undefined> {
    const result = await this.pool.query('SELECT json FROM artifacts WHERE run_id = $1 AND name = $2', [runId, name])
    return (result.rows[0] as { json: string } | undefined)?.json
  }

  async persistReplayProbe(runId: string, replayJson: string): Promise<void> {
    await this.pool.query('UPDATE runs SET replay_json = $1 WHERE id = $2 AND archived = 0', [replayJson, runId])
  }

  async archiveTenantRuns(tenantId: string): Promise<void> {
    await this.pool.query('UPDATE runs SET archived = 1 WHERE tenant_id = $1', [tenantId])
  }

  async retractProvisioningRun(runId: string): Promise<boolean> {
    const result = await this.pool.query(
      "UPDATE runs SET archived = 1 WHERE id = $1 AND state = 'provisioning' AND archived = 0",
      [runId],
    )
    return (result.rowCount ?? 0) > 0
  }

  async close(): Promise<void> {
    // Idempotent: shutdown paths can close the same store twice (two engine
    // instances sharing one store, engine close + process exit), and pg-pool
    // throws on a second end().
    this.closed ??= this.pool.end()
    await this.closed
  }
}
