/* Adversarial adapter regressions. Every database connection is test-gated. */
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Pool } from 'pg'
import { PostgresRunStore, resolvePostgresConfig } from './pg-run-store'
import { PostgresReceiptStore } from './pg-receipt-store'
import { createPostgresPool, withPostgresTransaction } from './pg-pool'
import { CONSUMPTION_SCHEMA, decisionDigest, type DecisionRecord } from '../../consumption/store'
import { WD_TEST_PG_URL, skipWhenNoPostgres, pgConfig, pgQuery } from '../../pg-test-env'

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const decision = (): DecisionRecord => ({ decisionId: randomUUID(), chosenOption: 'defer', rationale: 'review',
  decidedAt: new Date().toISOString(), decisionRequestId: randomUUID(), permittedAction: 'defer' })
const candidate = (tenantId: string) => ({ id: randomUUID(), tenantId, invocationA: randomUUID(),
  startedAt: new Date().toISOString(), phaseChangedAt: new Date().toISOString(), milestonesJson: '[]' })
function configWithOptions(options: string, name: string = randomUUID()) {
  const url = new URL(WD_TEST_PG_URL!)
  url.searchParams.set('options', options)
  url.searchParams.set('application_name', name)
  return { connectionString: url.toString(), max: 1 }
}
async function waitForLock(classId: number, count = 1) {
  for (let i = 0; i < 200; i++) {
    const result = await pgQuery('SELECT count(*)::int AS n FROM pg_locks WHERE locktype = $1 AND classid = $2 AND NOT granted', ['advisory', classId])
    if (Number(result.rows[0].n) >= count) return
    await delay(10)
  }
  assert.fail(`expected ${count} blocked advisory lock(s) in class ${classId}`)
}

test('discrete WD_PG fields do not require WD_PG_HOST', () => {
  const keys = ['WD_PG_URL', 'DATABASE_URL', 'WD_PG_HOST', 'WD_PG_PORT', 'WD_PG_USER', 'WD_PG_PASSWORD', 'WD_PG_DATABASE']
  const saved = keys.map(key => process.env[key])
  try {
    keys.forEach(key => delete process.env[key])
    Object.assign(process.env, { WD_PG_PORT: '6543', WD_PG_USER: 'wd-user', WD_PG_PASSWORD: 'test-only', WD_PG_DATABASE: 'wd-db' })
    const config = resolvePostgresConfig()
    assert.equal(config.port, 6543)
    assert.equal(config.user, 'wd-user')
    assert.equal(config.password, 'test-only')
    assert.equal(config.database, 'wd-db')
    assert.equal(config.host, undefined)
    process.env.WD_PG_URL = ''
    process.env.DATABASE_URL = 'postgres://fallback/db'
    assert.equal(resolvePostgresConfig().connectionString, 'postgres://fallback/db')
  } finally {
    keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i] })
  }
})

if (skipWhenNoPostgres('store-review-pg suite')) {
  test('a contended replay rechecks expiry before reading the winner', async () => {
    const store = new PostgresReceiptStore(pgConfig())
    const d = { ...decision(), expiresAt: new Date(Date.now() + 1500).toISOString() }
    await store.getReceipt(d.decisionId)
    const holder = new Pool(pgConfig())
    const client = await holder.connect()
    let pending: ReturnType<PostgresReceiptStore['claim']> | undefined
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(7002, hashtext($1))', [d.decisionId])
      pending = store.claim(d, 'same-successor')
      await waitForLock(7002)
      // A winner commits while the loser waits, then the approval expires.
      const receipt = { schema: CONSUMPTION_SCHEMA, receiptId: randomUUID(), decisionId: d.decisionId,
        decisionDigest: decisionDigest(d), decisionRequestId: d.decisionRequestId, permittedAction: d.permittedAction,
        successorInvocationId: 'same-successor', claimedAt: new Date().toISOString(), claimNote: 'fixture' }
      await client.query('INSERT INTO consumption_receipts VALUES ($1, $2, $3, $4, $5)',
        [d.decisionId, JSON.stringify(receipt), 'same-successor', receipt.decisionDigest, receipt.claimedAt])
      await delay(Math.max(0, Date.parse(d.expiresAt) - Date.now() + 25))
      await client.query('COMMIT')
      const result = await pending
      assert.equal(result.status, 'rejected')
      if (result.status === 'rejected') assert.equal(result.reason, 'expired')
      assert.deepEqual(await store.getReceipt(d.decisionId), receipt, 'winner history is untouched')
    } finally {
      await client.query('ROLLBACK')
      client.release()
      await pending?.catch(() => {})
      await holder.end()
      await store.close()
    }
  })

  test('pending claim snapshots the decision before any await', async () => {
    const store = new PostgresReceiptStore(pgConfig())
    const d = decision()
    await store.getReceipt(d.decisionId)
    const original = { ...d }
    const holder = new Pool(pgConfig())
    const client = await holder.connect()
    let pending: ReturnType<PostgresReceiptStore['claim']> | undefined
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(7002, hashtext($1))', [d.decisionId])
      pending = store.claim(d, 'successor', decisionDigest(d))
      await waitForLock(7002)
      d.permittedAction = 'different authority'
      d.expiresAt = '2000-01-01T00:00:00Z'
      await client.query('COMMIT')
      const result = await pending
      assert.equal(result.status, 'claimed')
      if (result.status === 'claimed') {
        assert.equal(result.receipt.decisionDigest, decisionDigest(original))
        assert.equal(result.receipt.permittedAction, original.permittedAction)
      }
    } finally {
      await client.query('ROLLBACK')
      client.release()
      await pending?.catch(() => {})
      await holder.end()
      await store.close()
    }
  })

  test('ensureActiveRun sees the winner even with a repeatable-read server default', async () => {
    const tenant = randomUUID()
    const stores = [0, 1].map(() => new PostgresRunStore(configWithOptions('-c default_transaction_isolation=repeatable\\ read')))
    await stores[0].initialize()
    const holder = new Pool(pgConfig())
    const client = await holder.connect()
    let pending: Promise<unknown>[] = []
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(7001, hashtext($1))', [tenant])
      pending = stores.map(store => store.ensureActiveRun(tenant, candidate(tenant)))
      await waitForLock(7001, 2)
      await client.query('COMMIT')
      const results = await Promise.all(pending)
      assert.deepEqual(results[0], results[1])
      assert.equal((await pgQuery('SELECT count(*)::int AS n FROM runs WHERE tenant_id = $1', [tenant])).rows[0].n, 1)
    } finally {
      await client.query('ROLLBACK')
      client.release()
      await Promise.allSettled(pending)
      await holder.end()
      await Promise.all(stores.map(store => store.close()))
    }
  })

  test('receipt schema initialization retries after a transient lock timeout', async () => {
    const store = new PostgresReceiptStore(configWithOptions('-c statement_timeout=100'))
    const holder = new Pool(pgConfig())
    const client = await holder.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(7003, 0)')
      await assert.rejects(store.getReceipt('missing'), { code: '57014' })
      await client.query('COMMIT')
      assert.equal(await store.getReceipt('missing'), undefined)
    } finally {
      await client.query('ROLLBACK')
      client.release()
      await holder.end()
      await store.close()
    }
  })

  test('concurrent intent and phase CAS return one winner under repeatable-read defaults', async () => {
    const stores = Array.from({ length: 8 }, () => new PostgresRunStore(configWithOptions('-c default_transaction_isolation=repeatable\\ read')))
    const run = candidate(randomUUID())
    try {
      await stores[0].initialize()
      await stores[0].insertRun(run)
      const intents = await Promise.all(stores.map((store, i) => store.acquireDecisionIntent(run.id, `inv-${i}`, JSON.stringify({ choice: i }))))
      assert.ok(intents.every(intent => JSON.stringify(intent) === JSON.stringify(intents[0])))
      const provisioned = await Promise.all(stores.map(store => store.markProvisioned(run.id)))
      assert.equal(provisioned.filter(Boolean).length, 1)
      const phases = await Promise.all(stores.map(store => store.updateRunPhase(run.id, 'running', 'decision_required', new Date().toISOString())))
      assert.equal(phases.filter(Boolean).length, 1)
      const finalized = await Promise.all(stores.map(store => store.finalizeDecision(run.id, 'decision_required', 'resuming', new Date().toISOString(), '{}', '{}')))
      assert.equal(finalized.filter(Boolean).length, 1)
      assert.equal((await stores[0].getRunRow(run.id))?.state, 'resuming')
    } finally {
      await Promise.all(stores.map(store => store.close()))
    }
  })

  test('failed transactions roll back their writes and release the only pool client', async () => {
    const pool = createPostgresPool(pgConfig(1))
    const store = new PostgresRunStore(pgConfig())
    const tenant = randomUUID()
    const run = candidate(tenant)
    try {
      await store.initialize()
      await store.insertRun(run)
      await assert.rejects(withPostgresTransaction(pool, async client => {
        await client.query('UPDATE runs SET archived = 1 WHERE id = $1', [run.id])
        await client.query('SELECT 1 / 0')
      }), { code: '22012' })
      assert.equal(pool.idleCount, 1)
      assert.equal((await store.getCurrentRun(tenant))?.id, run.id)
      assert.equal(await withPostgresTransaction(pool, async client => (await client.query('SELECT 1 AS n')).rows[0].n), 1)
    } finally {
      await store.close()
      await pool.end()
    }
  })

  test('a failed rollback discards the client instead of returning an open transaction', async () => {
    const pool = createPostgresPool(pgConfig(1))
    const failure = new Error('body failed')
    try {
      await assert.rejects(withPostgresTransaction(pool, async client => {
        const query = client.query.bind(client)
        client.query = ((...args: Parameters<typeof client.query>) => {
          if (String(args[0]) === 'ROLLBACK') return Promise.reject(new Error('rollback failed'))
          return query(...args)
        }) as typeof client.query
        throw failure
      }), error => error === failure)
      assert.equal(pool.totalCount, 0)
      assert.equal((await pool.query('SELECT 1 AS n')).rows[0].n, 1)
    } finally {
      await pool.end()
    }
  })

  test('a checked-out connection terminated between queries rejects and reconnects', async () => {
    const pool = createPostgresPool(pgConfig(1))
    try {
      await assert.rejects(withPostgresTransaction(pool, async client => {
        const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
        const disconnected = new Promise<void>(resolve => client.once('error', () => resolve()))
        await pgQuery('SELECT pg_terminate_backend($1)', [pid])
        await disconnected
      }), { code: '57P01' })
      assert.equal(pool.totalCount, 0)
      assert.equal((await pool.query('SELECT 1 AS n')).rows[0].n, 1)
    } finally {
      await pool.end()
    }
  })

  for (const kind of ['run', 'receipt']) {
    test(`${kind} pool survives an idle backend termination and reconnects`, async () => {
      const name = `review-idle-${randomUUID()}`
      const source = `
        import { PostgresRunStore } from './src/server/store/pg-run-store.ts';
        import { PostgresReceiptStore } from './src/server/store/pg-receipt-store.ts';
        import { Pool } from 'pg';
        const url = new URL(process.env.WD_TEST_PG_URL);
        url.searchParams.set('application_name', ${JSON.stringify(name)});
        const store = ${kind === 'run' ? 'new PostgresRunStore' : 'new PostgresReceiptStore'}({ connectionString: url.toString(), max: 1 });
        const query = () => ${kind === 'run' ? "store.getCurrentRun('missing')" : "store.getReceipt('missing')"};
        ${kind === 'run' ? 'await store.initialize();' : ''}
        await query();
        const killer = new Pool({ connectionString: process.env.WD_TEST_PG_URL });
        await killer.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1', [${JSON.stringify(name)}]);
        await new Promise(r => setTimeout(r, 100));
        await query();
        await store.close(); await store.close(); await killer.end();
      `
      await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], { timeout: 10000 })
    })
  }
}
