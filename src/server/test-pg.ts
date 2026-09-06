/* Console engine tests on Postgres — a port of src/server/test.ts (the
 * 16-test engine contract) with the raw better-sqlite3 probes replaced by
 * pg queries. The engine is unmodified: PostgresRunStore/PostgresReceiptStore
 * are injected through the same `stores` seam, and the factory selection
 * (WD_STORE) is covered by its own test. Run: npm run test:console-pg
 * (green skip without WD_TEST_PG_URL). */
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ConsoleEngine as ConsoleEngineType } from './state'
import { PostgresRunStore } from './store/pg-run-store'
import { PostgresReceiptStore } from './store/pg-receipt-store'
import { createDefaultStores } from './store/factory'
import type { RunStore } from './store/store'
import { WD_TEST_PG_URL, skipWhenNoPostgres, pgConfig, pgQuery } from '../pg-test-env'

let ConsoleEngine: typeof ConsoleEngineType

interface TestEngine {
  engine: ConsoleEngineType
  runs: RunStore
  tenant: string
  receipts: PostgresReceiptStore
}

async function freshEngine(name: string): Promise<TestEngine> {
  const tenant = `${name}-${randomUUID()}`
  const runs = new PostgresRunStore(pgConfig())
  const receipts = new PostgresReceiptStore(pgConfig())
  const engine = new ConsoleEngine(tenant, { runs, receipts })
  await engine.getState() // awaits schema initialization via the ready promise
  return { engine, runs, receipts, tenant }
}

async function cleanup(te: TestEngine): Promise<void> {
  await te.engine.close()
}

/** Fast-forward the wall-clock phases by aging THIS tenant's phase marker
 * (pg counterpart of the sqlite suite's direct UPDATE). */
async function agePhase(tenant: string, seconds: number): Promise<void> {
  await pgQuery('UPDATE runs SET phase_changed_at = $1 WHERE tenant_id = $2', [
    new Date(Date.now() - seconds * 1000).toISOString(), tenant,
  ])
}

async function runToDecision(te: TestEngine): Promise<string> {
  await te.engine.startRun()
  await agePhase(te.tenant, 10)
  return (await te.engine.getState()).runId
}

async function readArtifact(runId: string, name: string): Promise<Record<string, unknown>> {
  const row = await pgQuery('SELECT json FROM artifacts WHERE run_id = $1 AND name = $2', [runId, name])
  assert.equal(row.rows.length, 1, `artifact ${name} present for ${runId}`)
  return JSON.parse(row.rows[0].json as string) as Record<string, unknown>
}

if (skipWhenNoPostgres('console-pg suite')) {
  // state.ts has a default singleton: import only with the gate open and
  // bind that singleton to the disposable test URL, never ambient config.
  const previousStore = process.env.WD_STORE
  const previousUrl = process.env.WD_PG_URL
  try {
    process.env.WD_STORE = 'postgres'
    process.env.WD_PG_URL = WD_TEST_PG_URL
    const state = await import('./state')
    ConsoleEngine = state.ConsoleEngine
    await state.default.close()
  } finally {
    if (previousStore === undefined) delete process.env.WD_STORE; else process.env.WD_STORE = previousStore
    if (previousUrl === undefined) delete process.env.WD_PG_URL; else process.env.WD_PG_URL = previousUrl
  }

  test('close releases both stores after initialization or receipt-close failure', async () => {
    for (const failInitialization of [true, false]) {
      const failure = new Error(failInitialization ? 'initialization failed' : 'receipt close failed')
      const runs = new PostgresRunStore(pgConfig())
      const receipts = new PostgresReceiptStore(pgConfig())
      let runsClosed = false
      let receiptsClosed = false
      const runClose = runs.close.bind(runs)
      const receiptClose = receipts.close.bind(receipts)
      if (failInitialization) runs.initialize = async () => { throw failure }
      runs.close = async () => { runsClosed = true; await runClose() }
      receipts.close = async () => {
        receiptsClosed = true
        await receiptClose()
        if (!failInitialization) throw failure
      }
      const engine = new ConsoleEngine('shutdown', { runs, receipts })
      await assert.rejects(engine.close(), error => error === failure)
      assert.equal(runsClosed, true)
      assert.equal(receiptsClosed, true)
    }
  })

  test('each choice executes only its own branch (send_back/defer never build a PR)', async () => {
    const branchMarker: Record<string, string> = {
      create_draft_pr: 'draft-PR receipt',
      send_back: 'created no PR',
      defer: 'executed nothing',
    }
    for (const [choice, marker] of Object.entries(branchMarker)) {
      const te = await freshEngine('branch')
      try {
        const runId = await runToDecision(te)
        const result = await te.engine.submitDecision(choice, `rationale for ${choice}`, 'test-key')
        assert.equal(result.ok, true, `${choice} should submit cleanly`)
        await agePhase(te.tenant, 10)
        const state = await te.engine.getState()
        assert.equal(state.state, 'completed')
        const payload = (state.effect?.exactPayload ?? {}) as Record<string, unknown>
        if (choice === 'create_draft_pr') {
          assert.ok('repo' in payload && 'branch' in payload, 'approval builds the draft-PR payload')
        } else {
          assert.ok(!('repo' in payload) && !('branch' in payload), `${choice} must not build a PR payload`)
          assert.ok('outcome' in payload, `${choice} records its own no-PR outcome`)
        }
        const report = await readArtifact(runId, 'agent-report')
        assert.ok(String(report.behaviour_implemented).includes(marker), `${choice} report names its branch`)
        assert.equal(report.requested_next_step, choice === 'create_draft_pr' ? 'complete' : choice === 'send_back' ? 'revise_and_resubmit' : 'revisit_on_request', `${choice} sets its own next step`)
        assert.ok(state.artifacts.every(a => a.valid), `${choice}: all artifacts valid`)
      } finally {
        await cleanup(te)
      }
    }
  })

  test('human-decision artifact records the submitted choice, rationale, and dynamic id', async () => {
    const te = await freshEngine('artifact')
    try {
      const runId = await runToDecision(te)
      await te.engine.submitDecision('send_back', 'my actual rationale text', 'test-key')
      const decision = await readArtifact(runId, 'human-decision')
      assert.equal(decision.reason, 'my actual rationale text')
      assert.equal(decision.decision, 'request_review')
      assert.equal(decision.to_status, 'draft')
      assert.match(String(decision.decision_id), /^decision-run-/)
      const receipt = await readArtifact(runId, 'consumption-receipt')
      assert.equal(receipt.decisionId, decision.decision_id, 'artifact and receipt share decision identity')
    } finally {
      await cleanup(te)
    }
  })

  test('retrying a committed decision returns idempotent success, not WRONG_STATE', async () => {
    const te = await freshEngine('retry')
    try {
      await runToDecision(te)
      const first = await te.engine.submitDecision('create_draft_pr', 'approved', 'key-1')
      assert.equal(first.ok, true)
      const retry = await te.engine.submitDecision('create_draft_pr', 'approved', 'key-1')
      assert.equal(retry.ok, true)
      assert.equal(retry.duplicate, true)
      const conflict = await te.engine.submitDecision('defer', 'changed my mind', 'key-2')
      assert.equal(conflict.ok, false)
      assert.equal(conflict.error, 'DECISION_ALREADY_RECORDED')
    } finally {
      await cleanup(te)
    }
  })

  test('the decision artifact cites a real evidence digest, not a placeholder', async () => {
    const te = await freshEngine('evidence')
    try {
      const runId = await runToDecision(te)
      await te.engine.submitDecision('create_draft_pr', 'approved', 'key-1')
      const decision = await readArtifact(runId, 'human-decision')
      const refs = decision.evidence_refs as string[]
      const digestRef = refs.find(r => String(r).startsWith('sha256:'))
      assert.ok(digestRef, 'evidence_refs carries a sha256 reference')
      assert.match(String(digestRef), /^sha256:[0-9a-f]{64}$/, 'the digest is a real 64-hex hash of the stop-response evidence')
    } finally {
      await cleanup(te)
    }
  })

  test('crash between claim and state-write recovers with the same successor (no competing claim)', async () => {
    const te = await freshEngine('crash')
    try {
      const runId = await runToDecision(te)
      await te.engine.submitDecision('create_draft_pr', 'approved', 'key-1')
      const successor = (await te.engine.getState()).invocationB
      // Simulate the crash window: the claim committed, the run row did not.
      await pgQuery("UPDATE runs SET state = 'decision_required', receipt_json = NULL, effect_json = NULL WHERE id = $1", [runId])
      const recovery = await te.engine.submitDecision('create_draft_pr', 'approved', 'key-1')
      assert.equal(recovery.ok, true, 'retry must recover, not strand the run')
      const receipt = await readArtifact(runId, 'consumption-receipt')
      assert.equal(receipt.successorInvocationId, successor, 'recovery reuses the persisted successor — never a competing claim')
      await agePhase(te.tenant, 10)
      assert.equal((await te.engine.getState()).state, 'completed')
    } finally {
      await cleanup(te)
    }
  })

  test('claim recovery preserves the original decision session across a restart', async () => {
    for (const originalChannel of [
      { sessionReference: 'original-operator-session', authEventRef: 'original-login' },
      undefined,
    ]) {
      const te = await freshEngine('session')
      const receipts = new PostgresReceiptStore(pgConfig())
      let engine = new ConsoleEngine(te.tenant, { runs: te.runs, receipts: {
        async claim(...args) {
          await receipts.claim(...args)
          throw new Error('simulated crash after durable claim')
        },
        close: () => receipts.close(),
      } })
      try {
        await engine.startRun()
        await agePhase(te.tenant, 10)
        await assert.rejects(engine.submitDecision('defer', 'original rationale', 'session-recovery', originalChannel), /simulated crash/)
        await engine.close()
        // Fresh store instances for the restarted engine (close() ended the
        // first pools; the receipt itself is durable in Postgres).
        engine = new ConsoleEngine(te.tenant, {
          runs: new PostgresRunStore(pgConfig()),
          receipts: new PostgresReceiptStore(pgConfig()),
        })
        const result = await engine.submitDecision('defer', 'retry rationale', 'session-recovery', {
          sessionReference: 'retrying-operator-session', authEventRef: 'later-login',
        })
        assert.equal(result.ok, true)
        const state = await engine.getState()
        const artifact = await readArtifact(state.runId, 'human-decision')
        const actor = artifact.actor as { authentication_context: { session_reference: string, auth_event_ref: string } }
        assert.equal(actor.authentication_context.session_reference,
          originalChannel?.sessionReference ?? 'demo-unauthenticated-local-console')
        if (originalChannel) assert.equal(actor.authentication_context.auth_event_ref, originalChannel.authEventRef)
        assert.equal(artifact.reason, 'original rationale')
        assert.deepEqual(Object.keys(state.decision!).sort(), ['choice', 'decidedAt', 'rationale'])
      } finally {
        await engine.close()
        await cleanup(te)
      }
    }
  })

  test('reset archives completed runs instead of deleting audit records', async () => {
    const te = await freshEngine('reset')
    try {
      const runId = await runToDecision(te)
      await te.engine.submitDecision('defer', 'not now', 'key-1')
      await agePhase(te.tenant, 10)
      assert.equal((await te.engine.getState()).state, 'completed')
      await te.engine.reset()
      assert.equal((await te.engine.getState()).state, 'ready', 'console is ready for a fresh run')
      const rows = await pgQuery('SELECT COUNT(*)::int AS n FROM runs WHERE archived = 1 AND tenant_id = $1', [te.tenant])
      const artifacts = await pgQuery('SELECT COUNT(*)::int AS n FROM artifacts WHERE run_id = $1', [runId])
      assert.equal(rows.rows[0].n, 1, 'completed run row survives reset')
      assert.ok((artifacts.rows[0].n as number) >= 8, 'completed run artifacts survive reset')
    } finally {
      await cleanup(te)
    }
  })

  test('a second start while a run is active returns the same run', async () => {
    const te = await freshEngine('second')
    try {
      const first = await te.engine.startRun()
      const second = await te.engine.startRun()
      assert.equal(second.runId, first.runId)
    } finally {
      await cleanup(te)
    }
  })

  test('tenants are isolated: separate runs, decisions, and resets in one database', async () => {
    const alpha = await freshEngine('tenant-alpha')
    const beta = await freshEngine('tenant-beta')
    try {
      await alpha.engine.startRun()
      await beta.engine.startRun()
      await agePhase(alpha.tenant, 10)
      await agePhase(beta.tenant, 10)
      const alphaRun = await alpha.engine.getState()
      const betaRun = await beta.engine.getState()
      assert.notEqual(alphaRun.runId, betaRun.runId, 'each tenant has its own run')
      assert.equal(alphaRun.tenantId, alpha.tenant)
      assert.equal(betaRun.tenantId, beta.tenant)

      const submitted = await alpha.engine.submitDecision('defer', 'alpha decides alone', 'alpha-key')
      assert.equal(submitted.ok, true)
      assert.equal((await beta.engine.getState()).decision, null, 'beta sees no decision from alpha')

      await alpha.engine.reset()
      assert.equal((await alpha.engine.getState()).state, 'ready', 'alpha back to ready')
      assert.notEqual((await beta.engine.getState()).runId, '', 'beta run survives alpha reset')
      assert.notEqual((await beta.engine.getState()).state, 'ready', 'beta run survives alpha reset')
    } finally {
      await cleanup(alpha)
      await cleanup(beta)
    }
  })

  test('concurrent starts and concurrent submissions are safe through the async seam', async () => {
    const te = await freshEngine('race')
    try {
      const starts = await Promise.all([te.engine.startRun(), te.engine.startRun()])
      assert.equal(starts[0].runId, starts[1].runId, 'concurrent starts return the same run')

      await agePhase(te.tenant, 10)

      const same = await Promise.all([
        te.engine.submitDecision('create_draft_pr', 'same choice', 'same-key'),
        te.engine.submitDecision('create_draft_pr', 'same choice', 'same-key'),
      ])
      assert.ok(same.every(r => r.ok), `same-key concurrent submissions both succeed: ${JSON.stringify(same)}`)

      // Exercise the crash window for the mismatched-key conflict path.
      const runId = (await te.engine.getState()).runId
      await pgQuery("UPDATE runs SET state = 'decision_required' WHERE id = $1", [runId])
      const conflict = await te.engine.submitDecision('create_draft_pr', 'same choice', 'different-key')
      assert.equal(conflict.ok, false)
      assert.equal(conflict.error, 'DECISION_ALREADY_RECORDED')
    } finally {
      await cleanup(te)
    }
  })

  test('write slots serialize across store instances sharing one database', async () => {
    const tenant = `shared-${randomUUID()}`
    const runs = new PostgresRunStore(pgConfig())
    const receipts = new PostgresReceiptStore(pgConfig())
    const alpha = new ConsoleEngine(tenant, { runs, receipts })
    const beta = new ConsoleEngine(tenant, { runs, receipts })
    try {
      const results = await Promise.all([
        alpha.startRun(),
        beta.startRun(),
        alpha.startRun(),
        beta.startRun(),
      ])
      assert.equal(results[0].runId, results[2].runId, 'alpha starts agree')
      assert.equal(results[1].runId, results[3].runId, 'beta starts agree')
    } finally {
      await alpha.close()
      await beta.close().catch(() => {})
    }
  })

  test('a repair caller may finish provisioning before the original creator', async () => {
    const te = await freshEngine('repair-wins')
    let creatorReached!: () => void
    let releaseCreator!: () => void
    const reached = new Promise<void>(resolve => { creatorReached = resolve })
    const released = new Promise<void>(resolve => { releaseCreator = resolve })
    const markProvisioned = te.runs.markProvisioned.bind(te.runs)
    let first = true
    te.runs.markProvisioned = async runId => {
      if (first) {
        first = false
        creatorReached()
        await released
      }
      return markProvisioned(runId)
    }
    const creator = te.engine.startRun()
    const creatorResult = Promise.allSettled([creator])
    try {
      await reached
      const repair = await te.engine.startRun()
      releaseCreator()
      assert.deepEqual(await creator, repair)
      assert.equal((await te.engine.getState()).state, 'running')
      assert.equal((await te.runs.listArtifacts(repair.runId, te.tenant)).length, 4)
    } finally {
      releaseCreator()
      await creatorResult
      await cleanup(te)
    }
  })

  test('an incompletely provisioned run is repaired by the next start (review P2)', async () => {
    const te = await freshEngine('repair')
    try {
      const runId = await te.engine.startRun()
      await pgQuery("DELETE FROM artifacts WHERE run_id = $1 AND name = 'stop-response'", [runId.runId])
      await te.engine.startRun()
      await agePhase(te.tenant, 10)
      const submitted = await te.engine.submitDecision('defer', 'repair test', 'repair-key')
      assert.equal(submitted.ok, true, `decision works after repair: ${JSON.stringify(submitted)}`)
      const state = await te.engine.getState()
      assert.ok(state.artifacts.some(a => a.name === 'stop-response' && a.valid), 'stop-response artifact restored and valid')
    } finally {
      await cleanup(te)
    }
  })

  test('phase transitions are compare-and-swap; cleanup respects completed provisioning', async () => {
    const te = await freshEngine('cas')
    try {
      await te.engine.startRun()
      await agePhase(te.tenant, 10)
      const store = te.runs
      const runId = (await te.engine.getState()).runId

      const won = await store.updateRunPhase(runId, 'decision_required', 'resuming', new Date().toISOString())
      assert.equal(won, true, 'CAS from the current state applies')
      const stale = await store.updateRunPhase(runId, 'decision_required', 'decision_required', new Date().toISOString())
      assert.equal(stale, false, 'stale CAS loses')
      const after = await te.engine.getState()
      assert.equal(after.state, 'resuming', 'a lost CAS cannot regress the phase')

      const stateRunId = after.runId
      assert.equal(await store.retractProvisioningRun(stateRunId), false, 'a running run is not retractable')
      await pgQuery("UPDATE runs SET state = 'provisioning' WHERE id = $1", [stateRunId])
      assert.equal(await store.retractProvisioningRun(stateRunId), true, 'a stuck provisioning run retracts')
    } finally {
      await cleanup(te)
    }
  })

  test('a slower duplicate finalize never regresses a completed run (review P2)', async () => {
    const te = await freshEngine('cas-final')
    try {
      await te.engine.startRun()
      await agePhase(te.tenant, 10)
      const store = te.runs
      const runId = (await te.engine.getState()).runId
      assert.equal(await store.finalizeDecision(runId, 'decision_required', 'resuming', new Date().toISOString(), '{}', '{}'), true, 'winner finalizes from decision_required')
      const advanced = await store.updateRunPhase(runId, 'resuming', 'completed', new Date().toISOString(), new Date().toISOString())
      assert.equal(advanced, true)
      const loser = await store.finalizeDecision(runId, 'decision_required', 'resuming', new Date().toISOString(), '{}', '{}')
      assert.equal(loser, false, 'stale finalize loses the CAS')
      const after = await te.engine.getState()
      assert.equal(after.state, 'completed', 'completed state survives the stale finalize')
      assert.ok(after.completedAt, 'completed_at stays populated')
    } finally {
      await cleanup(te)
    }
  })

  test('audit artifacts are immutable and archived rows are never mutated (review round 6)', async () => {
    const te = await freshEngine('immutable')
    try {
      await te.engine.startRun()
      await agePhase(te.tenant, 10)
      const runId = (await te.engine.getState()).runId
      const store = te.runs

      await store.storeArtifact({ runId, tenantId: te.tenant, name: 'audit-probe', kind: 'review-finding', valid: true, json: '{"first":true}' })
      await store.storeArtifact({ runId, tenantId: te.tenant, name: 'audit-probe', kind: 'review-finding', valid: true, json: '{"second":false}' })
      const persisted = await store.getArtifactJson(runId, 'audit-probe')
      assert.equal(persisted, '{"first":true}', 'the first committed artifact survives a later writer')

      assert.equal(await store.updateRunPhase(runId, 'decision_required', 'resuming', new Date().toISOString()), true, 'live CAS applies')
      await store.archiveTenantRuns(te.tenant)
      assert.equal(
        await store.updateRunPhase(runId, 'resuming', 'completed', new Date().toISOString(), new Date().toISOString()),
        false,
        'archived row is untouchable by a stale poll',
      )
    } finally {
      await cleanup(te)
    }
  })

  test('provisioning completion restarts the phase clock (review round 7)', async () => {
    const te = await freshEngine('clock')
    try {
      await te.engine.startRun()
      const state = await te.engine.getState()
      assert.equal(state.state, 'running', 'fresh run shows the visible running phase')
      await new Promise(r => setTimeout(r, 50))
      assert.equal((await te.engine.getState()).state, 'running', 'still running well after start returns')
    } finally {
      await cleanup(te)
    }
  })

  test('artifacts list in insertion order across tenants (seq replaces rowid)', async () => {
    const te = await freshEngine('ordering')
    try {
      await te.engine.startRun()
      const runId = (await te.engine.getState()).runId
      const names = (await te.runs.listArtifacts(runId, te.tenant)).map(a => a.name)
      assert.ok(names.indexOf('task-packet') < names.indexOf('stop-response'), 'invocation-A artifacts render in write order')
    } finally {
      await cleanup(te)
    }
  })

  test('WD_STORE=postgres factory wires both Postgres stores', async () => {
    const previous = process.env.WD_STORE
    process.env.WD_STORE = 'postgres'
    try {
      const stores = createDefaultStores('/tmp/unused-when-postgres')
      assert.ok(stores.runs instanceof PostgresRunStore)
      assert.ok(stores.receipts instanceof PostgresReceiptStore)
      await stores.runs.close()
      await stores.receipts.close()
    } finally {
      if (previous === undefined) delete process.env.WD_STORE
      else process.env.WD_STORE = previous
    }
  })

  test('WD_STORE rejects unknown backends', () => {
    const previous = process.env.WD_STORE
    process.env.WD_STORE = 'mysql'
    try {
      assert.throws(() => createDefaultStores('/tmp/unused'), /WD_STORE must be/)
    } finally {
      if (previous === undefined) delete process.env.WD_STORE
      else process.env.WD_STORE = previous
    }
  })

  test('connection config precedence: explicit fields beat ambient URLs', async () => {
    const { resolvePostgresConfig } = await import('./store/pg-run-store')
    const saved = { url: process.env.WD_PG_URL, dbUrl: process.env.DATABASE_URL, host: process.env.WD_PG_HOST }
    try {
      process.env.WD_PG_URL = 'postgres://env-user@env-host/env-db'
      process.env.DATABASE_URL = 'postgres://ambient@ambient-host/ambient-db'
      delete process.env.WD_PG_HOST

      // Explicit connectionString beats everything.
      assert.equal(resolvePostgresConfig({ connectionString: 'postgres://x' }).connectionString, 'postgres://x')
      // Environment URL applies only with no explicit connection fields.
      assert.equal(resolvePostgresConfig().connectionString, 'postgres://env-user@env-host/env-db')
      // Discrete overrides must NOT be silently overridden by an ambient URL
      // (pg gives connectionString precedence over discrete fields).
      const mixed = resolvePostgresConfig({ host: 'explicit-host', database: 'explicit-db' })
      assert.equal(mixed.connectionString, undefined, 'ambient URL must not leak into a discrete config')
      assert.equal(mixed.host, 'explicit-host')
      assert.equal(mixed.database, 'explicit-db')
      // Discrete WD_PG_* env fallbacks apply only once no URL is set
      // (an environment URL is a complete connection and wins over them).
      delete process.env.WD_PG_URL
      delete process.env.DATABASE_URL
      process.env.WD_PG_HOST = 'env-pg-host'
      assert.equal(resolvePostgresConfig().host, 'env-pg-host')
    } finally {
      if (saved.url === undefined) delete process.env.WD_PG_URL; else process.env.WD_PG_URL = saved.url
      if (saved.dbUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = saved.dbUrl
      if (saved.host === undefined) delete process.env.WD_PG_HOST; else process.env.WD_PG_HOST = saved.host
    }
  })
}
