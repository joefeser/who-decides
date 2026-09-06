/* Console engine tests: branch execution, runtime-built decision artifacts,
 * idempotent recovery, crash-safe successor reuse, archived reset, and the
 * one-active-run invariant. Run: npm run test:console */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { ConsoleEngine } from './state'
import { SqliteReceiptStore } from './store/sqlite-receipt-store'

function freshEngine(): { engine: ConsoleEngine, dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'wd-console-test-'))
  process.env.WD_CONSOLE_DIR = dir
  return { engine: new ConsoleEngine(), dir }
}

async function cleanup(dir: string, engine: ConsoleEngine): Promise<void> {
  delete process.env.WD_CONSOLE_DIR
  await engine.close()
  rmSync(dir, { recursive: true, force: true })
}

/** Fast-forward the wall-clock phases by aging the current phase marker. */
function agePhase(dir: string, seconds: number): void {
  const db = new Database(path.join(dir, 'state.db'))
  db.prepare('UPDATE runs SET phase_changed_at = ?').run(new Date(Date.now() - seconds * 1000).toISOString())
  db.close()
}

async function runToDecision(engine: ConsoleEngine, dir: string): Promise<void> {
  await engine.startRun()
  agePhase(dir, 10)
}

function readArtifact(dir: string, name: string): Record<string, unknown> {
  const db = new Database(path.join(dir, 'state.db'))
  const row = db.prepare('SELECT json FROM artifacts WHERE name = ?').get(name) as { json: string }
  db.close()
  return JSON.parse(row.json) as Record<string, unknown>
}

test('each choice executes only its own branch (send_back/defer never build a PR)', async () => {
  const branchMarker: Record<string, string> = {
    create_draft_pr: 'draft-PR receipt',
    send_back: 'created no PR',
    defer: 'executed nothing',
  }
  for (const [choice, marker] of Object.entries(branchMarker)) {
    const { engine, dir } = freshEngine()
    try {
      await runToDecision(engine, dir)
      const result = await engine.submitDecision(choice, `rationale for ${choice}`, 'test-key')
      assert.equal(result.ok, true, `${choice} should submit cleanly`)
      agePhase(dir, 10)
      const state = await engine.getState()
      assert.equal(state.state, 'completed')
      const payload = (state.effect?.exactPayload ?? {}) as Record<string, unknown>
      if (choice === 'create_draft_pr') {
        assert.ok('repo' in payload && 'branch' in payload, 'approval builds the draft-PR payload')
      } else {
        assert.ok(!('repo' in payload) && !('branch' in payload), `${choice} must not build a PR payload`)
        assert.ok('outcome' in payload, `${choice} records its own no-PR outcome`)
      }
      const report = readArtifact(dir, 'agent-report')
      assert.ok(String(report.behaviour_implemented).includes(marker), `${choice} report names its branch`)
      assert.equal(report.requested_next_step, choice === 'create_draft_pr' ? 'complete' : choice === 'send_back' ? 'revise_and_resubmit' : 'revisit_on_request', `${choice} sets its own next step`)
      assert.ok(state.artifacts.every(a => a.valid), `${choice}: all artifacts valid`)
    } finally {
      await cleanup(dir, engine)
    }
  }
})

test('human-decision artifact records the submitted choice, rationale, and dynamic id', async () => {
  const { engine, dir } = freshEngine()
  try {
    await runToDecision(engine, dir)
    await engine.submitDecision('send_back', 'my actual rationale text', 'test-key')
    const decision = readArtifact(dir, 'human-decision')
    assert.equal(decision.reason, 'my actual rationale text')
    assert.equal(decision.decision, 'request_review')
    assert.equal(decision.to_status, 'draft')
    assert.match(String(decision.decision_id), /^decision-run-/)
    const receipt = readArtifact(dir, 'consumption-receipt')
    assert.equal(receipt.decisionId, decision.decision_id, 'artifact and receipt share decision identity')
  } finally {
    await cleanup(dir, engine)
  }
})

test('retrying a committed decision returns idempotent success, not WRONG_STATE', async () => {
  const { engine, dir } = freshEngine()
  try {
    await runToDecision(engine, dir)
    const first = await engine.submitDecision('create_draft_pr', 'approved', 'key-1')
    assert.equal(first.ok, true)
    const retry = await engine.submitDecision('create_draft_pr', 'approved', 'key-1')
    assert.equal(retry.ok, true)
    assert.equal(retry.duplicate, true)
    // A DIFFERENT decision after one was recorded is a conflict, not a
    // duplicate success — the first decision was consumed.
    const conflict = await engine.submitDecision('defer', 'changed my mind', 'key-2')
    assert.equal(conflict.ok, false)
    assert.equal(conflict.error, 'DECISION_ALREADY_RECORDED')
  } finally {
    await cleanup(dir, engine)
  }
})

test('the decision artifact cites a real evidence digest, not a placeholder', async () => {
  const { engine, dir } = freshEngine()
  try {
    await runToDecision(engine, dir)
    await engine.submitDecision('create_draft_pr', 'approved', 'key-1')
    const decision = readArtifact(dir, 'human-decision')
    const refs = decision.evidence_refs as string[]
    const digestRef = refs.find(r => String(r).startsWith('sha256:'))
    assert.ok(digestRef, 'evidence_refs carries a sha256 reference')
    assert.match(String(digestRef), /^sha256:[0-9a-f]{64}$/, 'the digest is a real 64-hex hash of the stop-response evidence')
  } finally {
    await cleanup(dir, engine)
  }
})

test('crash between claim and state-write recovers with the same successor (no competing claim)', async () => {
  const { engine, dir } = freshEngine()
  try {
    await runToDecision(engine, dir)
    await engine.submitDecision('create_draft_pr', 'approved', 'key-1')
    const successor = (await engine.getState()).invocationB
    // Simulate the crash window: the claim committed, the run row did not.
    const db = new Database(path.join(dir, 'state.db'))
    db.prepare("UPDATE runs SET state = 'decision_required', receipt_json = NULL, effect_json = NULL").run()
    db.close()
    const recovery = await engine.submitDecision('create_draft_pr', 'approved', 'key-1')
    assert.equal(recovery.ok, true, 'retry must recover, not strand the run')
    const receipt = readArtifact(dir, 'consumption-receipt')
    assert.equal(receipt.successorInvocationId, successor, 'recovery reuses the persisted successor — never a competing claim')
    agePhase(dir, 10)
    assert.equal((await engine.getState()).state, 'completed')
  } finally {
    await cleanup(dir, engine)
  }
})

test('claim recovery preserves the original decision session across a restart', async () => {
  for (const originalChannel of [
    { sessionReference: 'original-operator-session', authEventRef: 'original-login' },
    undefined,
  ]) {
    const dir = mkdtempSync(path.join(tmpdir(), 'wd-session-recovery-'))
    process.env.WD_CONSOLE_DIR = dir
    const receipts = new SqliteReceiptStore(path.join(dir, 'consumption.db'))
    let engine = new ConsoleEngine('default', { receipts: {
      async claim(...args) {
        await receipts.claim(...args)
        throw new Error('simulated crash after durable claim')
      },
      close: () => receipts.close(),
    } })
    try {
      await runToDecision(engine, dir)
      await assert.rejects(engine.submitDecision('defer', 'original rationale', 'session-recovery', originalChannel), /simulated crash/)
      await engine.close()
      engine = new ConsoleEngine()
      const result = await engine.submitDecision('defer', 'retry rationale', 'session-recovery', {
        sessionReference: 'retrying-operator-session', authEventRef: 'later-login',
      })
      assert.equal(result.ok, true)
      const artifact = readArtifact(dir, 'human-decision')
      const actor = artifact.actor as { authentication_context: { session_reference: string, auth_event_ref: string } }
      assert.equal(actor.authentication_context.session_reference,
        originalChannel?.sessionReference ?? 'demo-unauthenticated-local-console')
      if (originalChannel) assert.equal(actor.authentication_context.auth_event_ref, originalChannel.authEventRef)
      assert.equal(artifact.reason, 'original rationale')
      assert.deepEqual(Object.keys((await engine.getState()).decision!).sort(), ['choice', 'decidedAt', 'rationale'])
    } finally {
      await cleanup(dir, engine)
    }
  }
})

test('reset archives completed runs instead of deleting audit records', async () => {
  const { engine, dir } = freshEngine()
  try {
    await runToDecision(engine, dir)
    await engine.submitDecision('defer', 'not now', 'key-1')
    agePhase(dir, 10)
    assert.equal((await engine.getState()).state, 'completed')
    await engine.reset()
    assert.equal((await engine.getState()).state, 'ready', 'console is ready for a fresh run')
    const db = new Database(path.join(dir, 'state.db'))
    const rows = db.prepare('SELECT COUNT(*) AS n FROM runs WHERE archived = 1').get() as { n: number }
    const artifacts = db.prepare('SELECT COUNT(*) AS n FROM artifacts').get() as { n: number }
    db.close()
    assert.equal(rows.n, 1, 'completed run row survives reset')
    assert.ok(artifacts.n >= 8, 'completed run artifacts survive reset')
  } finally {
    await cleanup(dir, engine)
  }
})

test('a second start while a run is active returns the same run', async () => {
  const { engine, dir } = freshEngine()
  try {
    const first = await engine.startRun()
    const second = await engine.startRun()
    assert.equal(second.runId, first.runId)
  } finally {
    await cleanup(dir, engine)
  }
})

test('tenants are isolated: separate runs, decisions, and resets in one database', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wd-tenant-test-'))
  process.env.WD_CONSOLE_DIR = dir
  const alpha = new ConsoleEngine('tenant-alpha')
  const beta = new ConsoleEngine('tenant-beta')
  try {
    // both tenants run concurrently in the SAME database file
    await alpha.startRun()
    await beta.startRun()
    agePhase(dir, 10)
    const alphaRun = await alpha.getState()
    const betaRun = await beta.getState()
    assert.notEqual(alphaRun.runId, betaRun.runId, 'each tenant has its own run')
    assert.equal(alphaRun.tenantId, 'tenant-alpha')
    assert.equal(betaRun.tenantId, 'tenant-beta')

    // alpha decides; beta's run is untouched
    const submitted = await alpha.submitDecision('defer', 'alpha decides alone', 'alpha-key')
    assert.equal(submitted.ok, true)
    assert.equal((await beta.getState()).decision, null, 'beta sees no decision from alpha')

    // resetting alpha does not archive beta's live run
    await alpha.reset()
    assert.equal((await alpha.getState()).state, 'ready', 'alpha back to ready')
    assert.equal((await beta.getState()).state, 'completed' === (await beta.getState()).state ? 'completed' : 'decision_required', 'beta run survives alpha reset')
    assert.notEqual((await beta.getState()).runId, '')
  } finally {
    await alpha.close()
    await beta.close()
    delete process.env.WD_CONSOLE_DIR
    rmSync(dir, { recursive: true, force: true })
  }
})

test('concurrent starts and concurrent submissions are safe through the async seam', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wd-seam-race-'))
  process.env.WD_CONSOLE_DIR = dir
  const engine = new ConsoleEngine('race')
  try {
    // Two overlapping starts must both resolve to ONE run, never a nested-
    // transaction error (review P1: write-slot re-entrancy).
    const starts = await Promise.all([engine.startRun(), engine.startRun()])
    assert.equal(starts[0].runId, starts[1].runId, 'concurrent starts return the same run')

    agePhase(dir, 10)

    // Two overlapping submissions with the SAME key+choice: both succeed
    // idempotently (loser adopts the stored intent; claim replays).
    const same = await Promise.all([
      engine.submitDecision('create_draft_pr', 'same choice', 'same-key'),
      engine.submitDecision('create_draft_pr', 'same choice', 'same-key'),
    ])
    assert.ok(same.every(r => r.ok), `same-key concurrent submissions both succeed: ${JSON.stringify(same)}`)

    // Mismatched key with the same choice is a conflict, not idempotent
    // success (review finding 3). Exercise the crash window: intent
    // persisted, run not finalized (state forced back to decision_required).
    const db = new Database(path.join(dir, 'state.db'))
    db.prepare("UPDATE runs SET state = 'decision_required'").run()
    db.close()
    const conflict = await engine.submitDecision('create_draft_pr', 'same choice', 'different-key')
    assert.equal(conflict.ok, false)
    assert.equal(conflict.error, 'DECISION_ALREADY_RECORDED')
  } finally {
    await cleanup(dir, engine)
  }
})

test('write slots serialize across store instances sharing one database file', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wd-seam-shared-'))
  process.env.WD_CONSOLE_DIR = dir
  const alpha = new ConsoleEngine('shared-a')
  const beta = new ConsoleEngine('shared-b')
  try {
    // Concurrent starts across two engines on ONE state file must never
    // collide on BEGIN IMMEDIATE (review P1: instance-local queues).
    const results = await Promise.all([
      alpha.startRun(),
      beta.startRun(),
      alpha.startRun(),
      beta.startRun(),
    ])
    assert.equal(results[0].runId, results[2].runId, 'alpha starts agree')
    assert.equal(results[1].runId, results[3].runId, 'beta starts agree')
  } finally {
    await cleanup(dir, alpha)
    await beta.close().catch(() => {})
  }
})

test('an incompletely provisioned run is repaired by the next start (review P2)', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wd-seam-repair-'))
  process.env.WD_CONSOLE_DIR = dir
  const engine = new ConsoleEngine('repair')
  try {
    await engine.startRun()
    // Simulate a provisioning failure: the evidence artifact never landed.
    const db = new Database(path.join(dir, 'state.db'))
    db.prepare("DELETE FROM artifacts WHERE name = 'stop-response'").run()
    db.close()
    // The next start (early-return path) repairs provisioning instead of
    // handing back a run whose decision submit would fail EVIDENCE_MISSING.
    await engine.startRun()
    agePhase(dir, 10)
    const submitted = await engine.submitDecision('defer', 'repair test', 'repair-key')
    assert.equal(submitted.ok, true, `decision works after repair: ${JSON.stringify(submitted)}`)
    const state = await engine.getState()
    assert.ok(state.artifacts.some(a => a.name === 'stop-response' && a.valid), 'stop-response artifact restored and valid')
  } finally {
    await cleanup(dir, engine)
  }
})

test('phase transitions are compare-and-swap; cleanup respects completed provisioning', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wd-cas-'))
  process.env.WD_CONSOLE_DIR = dir
  const engine = new ConsoleEngine('cas')
  try {
    await engine.startRun()
    agePhase(dir, 10)
    const store = (engine as unknown as { runs: import('./store/store').RunStore }).runs

    // CAS: transition from the observed state wins…
    const won = await store.updateRunPhase((await engine.getState()).runId, 'decision_required', 'resuming', new Date().toISOString())
    assert.equal(won, true, 'CAS from the current state applies')
    // …and a stale transition from the OLD state must NOT overwrite.
    const stale = await store.updateRunPhase((await engine.getState()).runId, 'decision_required', 'decision_required', new Date().toISOString())
    assert.equal(stale, false, 'stale CAS loses')
    const after = await engine.getState()
    assert.equal(after.state, 'resuming', 'a lost CAS cannot regress the phase')

    // Guarded cleanup is state-based now: a completed provisioning ('running')
    // run is never retracted; a stuck 'provisioning' run is.
    const runId = after.runId
    assert.equal(await store.retractProvisioningRun(runId), false, 'a running run is not retractable')
    const db = new Database(path.join(dir, 'state.db'))
    db.prepare("UPDATE runs SET state = 'provisioning' WHERE id = ?").run(runId)
    db.close()
    assert.equal(await store.retractProvisioningRun(runId), true, 'a stuck provisioning run retracts')
  } finally {
    await cleanup(dir, engine)
  }
})

test('a slower duplicate finalize never regresses a completed run (review P2)', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wd-cas-final-'))
  process.env.WD_CONSOLE_DIR = dir
  const engine = new ConsoleEngine('cas-final')
  try {
    await engine.startRun()
    agePhase(dir, 10)
    const store = (engine as unknown as { runs: import('./store/store').RunStore }).runs
    const runId = (await engine.getState()).runId
    // The winner finalized and a poll advanced the run to completed…
    assert.equal(await store.finalizeDecision(runId, 'decision_required', 'resuming', new Date().toISOString(), '{}', '{}'), true, 'winner finalizes from decision_required')
    const advanced = await store.updateRunPhase(runId, 'resuming', 'completed', new Date().toISOString(), new Date().toISOString())
    assert.equal(advanced, true)
    // …the slower duplicate's finalize must lose (CAS) and leave completed intact.
    const loser = await store.finalizeDecision(runId, 'decision_required', 'resuming', new Date().toISOString(), '{}', '{}')
    assert.equal(loser, false, 'stale finalize loses the CAS')
    const after = await engine.getState()
    assert.equal(after.state, 'completed', 'completed state survives the stale finalize')
    assert.ok(after.completedAt, 'completed_at stays populated')
  } finally {
    await cleanup(dir, engine)
  }
})

test('audit artifacts are immutable and archived rows are never mutated (review round 6)', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wd-immutable-'))
  process.env.WD_CONSOLE_DIR = dir
  const engine = new ConsoleEngine('immutable')
  try {
    await engine.startRun()
    agePhase(dir, 10)
    const runId = (await engine.getState()).runId
    const store = (engine as unknown as { runs: import('./store/store').RunStore }).runs

    // First-writer-wins: a second write with different content is a no-op.
    await store.storeArtifact({ runId, tenantId: 'immutable', name: 'audit-probe', kind: 'review-finding', valid: true, json: '{"first":true}' })
    await store.storeArtifact({ runId, tenantId: 'immutable', name: 'audit-probe', kind: 'review-finding', valid: true, json: '{"second":false}' })
    const persisted = await store.getArtifactJson(runId, 'audit-probe')
    assert.equal(persisted, '{"first":true}', 'the first committed artifact survives a later writer')

    // Archiving wins races: CAS transitions cannot touch archived rows.
    assert.equal(await store.updateRunPhase(runId, 'decision_required', 'resuming', new Date().toISOString()), true, 'live CAS applies')
    await store.archiveTenantRuns('immutable')
    assert.equal(
      await store.updateRunPhase(runId, 'resuming', 'completed', new Date().toISOString(), new Date().toISOString()),
      false,
      'archived row is untouchable by a stale poll',
    )
  } finally {
    await cleanup(dir, engine)
  }
})

test('provisioning completion restarts the phase clock (review round 7)', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wd-clock-'))
  process.env.WD_CONSOLE_DIR = dir
  const engine = new ConsoleEngine('clock')
  try {
    await engine.startRun()
    // startRun completes provisioning; the visible running phase must be
    // measured from COMPLETION, not from the pre-provisioning insert time.
    const state = await engine.getState()
    assert.equal(state.state, 'running', 'fresh run shows the visible running phase')
    await new Promise(r => setTimeout(r, 50))
    assert.equal((await engine.getState()).state, 'running', 'still running well after start returns')
  } finally {
    await cleanup(dir, engine)
  }
})
