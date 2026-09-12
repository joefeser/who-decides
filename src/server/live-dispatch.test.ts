import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { ConsoleEngine } from './state'
import { SqliteRunStore } from './store/sqlite-run-store'
import { SqliteReceiptStore } from './store/sqlite-receipt-store'
import { createAgentDispatcher } from './agent-dispatch'
import { patchScenario as f } from '../agent-service/fixture'
import { decisionDigest } from '../consumption/store'

function setup(invoke: (payload: Record<string, unknown>) => Promise<Record<string, unknown>>) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wd-live-console-'))
  const runs = new SqliteRunStore(dir)
  const receipts = new SqliteReceiptStore(path.join(dir, 'consumption.db'))
  const engine = new ConsoleEngine('live-test', { runs, receipts })
  const dispatcher = createAgentDispatcher({ endpoint: 'synthetic-runtime', machineToken: 'synthetic-token' }, { invoke })
  return { engine, runs, receipts, dispatcher, dir, close: async () => { await engine.close(); rmSync(dir, { recursive: true, force: true }) } }
}
const startResult = (sessionId: unknown) => ({ ok: true, result: { status: 'DECISION_REQUIRED', decisionId: `decision-svc-${sessionId}`, invocationA: 'runtime-invocation-a', decisionRequest: { patchId: `${f.package}-${f.to_version}`, question: f.decision_request.question, options: f.decision_request.options } } })
const completed = (sessionId: unknown, choice: unknown) => ({ ok: true, result: { status: 'COMPLETED', decisionId: `decision-svc-${sessionId}`, receiptId: 'runtime-receipt', invocationB: 'runtime-successor', effect: { effect: choice, mode: 'dry-run', noExternalMutationPerformed: true, authorizedBy: { decisionId: `decision-svc-${sessionId}`, consumptionReceiptId: 'runtime-receipt', successorInvocationId: 'runtime-successor' } } } })
function age(dir: string) {
  const db = new Database(path.join(dir, 'state.db'))
  db.prepare('UPDATE runs SET phase_changed_at = ?').run('2000-01-01T00:00:00.000Z')
  db.close()
}

test('failed live start never reaches the human gate or completion by elapsed time', async () => {
  const t = setup(async () => { throw new Error('synthetic runtime unavailable') })
  try {
    const { runId } = await t.engine.startRun(false, t.dispatcher)
    age(t.dir)
    assert.equal((await t.engine.getState()).state, 'running')
    assert.equal((await t.engine.dispatchStart(runId, t.dispatcher)).ok, false)
    age(t.dir)
    const state = await t.engine.getState()
    assert.equal(state.state, 'blocked')
    assert.match(state.agent!.error!, /runtime unavailable/)
    assert.equal(state.effect, null)
  } finally { await t.close() }
})

test('only the confirmed live resume completes; a concurrent retry cannot dispatch twice', async () => {
  let release!: () => void
  let entered!: () => void
  const began = new Promise<void>(resolve => { entered = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  let resumes = 0
  const t = setup(async payload => {
    if (payload.kind === 'decision-run') return startResult(payload.sessionId)
    resumes++; entered(); await held
    return completed(payload.sessionId, payload.choice)
  })
  try {
    const { runId } = await t.engine.startRun(false, t.dispatcher)
    assert.equal((await t.engine.dispatchStart(runId, t.dispatcher)).ok, true)
    const result = t.engine.submitDecision('defer', 'approved deferral', 'key', undefined, runId, t.dispatcher)
    await began
    age(t.dir)
    assert.equal((await t.engine.getState()).state, 'resuming')
    assert.equal((await t.engine.getState()).effect, null)
    await assert.rejects(t.engine.reset(), /DECISION_IN_PROGRESS/)
    assert.equal((await t.engine.submitDecision('defer', 'approved deferral', 'key', undefined, runId, t.dispatcher)).ok, false)
    release()
    assert.equal((await result).ok, true)
    const state = await t.engine.getState()
    assert.equal(state.state, 'completed')
    assert.ok(state.completedAt)
    assert.equal(resumes, 1)
    assert.equal((await t.engine.submitDecision('defer', 'approved deferral', 'key', undefined, runId, t.dispatcher)).duplicate, true)
    assert.equal(resumes, 1)
  } finally { release(); await t.close() }
})

test('a typed live resume rejection does not produce completion artifacts', async () => {
  const t = setup(async payload => payload.kind === 'decision-run' ? startResult(payload.sessionId) : { ok: false, error: 'synthetic resume failure' })
  try {
    const { runId } = await t.engine.startRun(false, t.dispatcher)
    await t.engine.dispatchStart(runId, t.dispatcher)
    assert.equal((await t.engine.submitDecision('defer', 'hold', 'key', undefined, runId, t.dispatcher)).ok, false)
    age(t.dir)
    const state = await t.engine.getState()
    assert.equal(state.state, 'blocked')
    assert.equal(state.effect, null)
    assert.equal(await t.runs.getArtifactJson(runId, 'agent-report'), undefined)
    await t.engine.reset()
  } finally { await t.close() }
})

test('stale displayed run and archived intent cannot consume a new run decision', async () => {
  const t = setup(async payload => startResult(payload.sessionId))
  try {
    const a = await t.engine.startRun()
    await t.engine.reset()
    assert.equal((await t.runs.acquireDecisionIntent(a.runId, 'stale-successor', '{}')).decision_json, null)
    const b = await t.engine.startRun()
    age(t.dir)
    assert.equal((await t.engine.submitDecision('defer', 'stale page', 'old', undefined, a.runId)).error, 'RUN_CHANGED')
    assert.equal((await t.runs.getRunRow(b.runId))!.decision_json, null)
  } finally { await t.close() }
})

test('a crashed pre-finalization live resume is repaired by resubmission without redispatch', async () => {
  let resumes = 0
  const t = setup(async payload => {
    if (payload.kind === 'decision-run') return startResult(payload.sessionId)
    resumes++
    return completed(payload.sessionId, payload.choice)
  })
  try {
    // Simulate a local persistence failure AFTER the runtime confirmed the
    // resume: the agent-resume dispatch artifact is already durable, so the
    // evidence to repair exists — only the local spine died mid-write.
    const originalStore = t.runs.storeArtifact.bind(t.runs)
    let failedOnce = false
    t.runs.storeArtifact = async (artifact: { name?: string }) => {
      if (artifact.name === 'effect-receipt' && !failedOnce) {
        failedOnce = true
        throw new Error('synthetic local persistence failure')
      }
      return originalStore(artifact as Parameters<typeof originalStore>[0])
    }
    const { runId } = await t.engine.startRun(false, t.dispatcher)
    await t.engine.dispatchStart(runId, t.dispatcher)
    await assert.rejects(t.engine.submitDecision('defer', 'approved deferral', 'key', undefined, runId, t.dispatcher), /persistence failure/)
    let state = await t.engine.getState()
    assert.equal(state.state, 'resuming')
    assert.equal(state.effect, null)
    await assert.rejects(t.engine.reset(), /DECISION_IN_PROGRESS/)
    // The same submission repairs: no redispatch, deterministic rebuild,
    // finalize wins the resuming → completed CAS.
    assert.equal((await t.engine.submitDecision('defer', 'approved deferral', 'key', undefined, runId, t.dispatcher)).ok, true)
    assert.equal(resumes, 1, 'the repair must not invoke the runtime again')
    state = await t.engine.getState()
    assert.equal(state.state, 'completed')
    assert.ok(state.effect, 'repaired run must display the executed effect')
    assert.notEqual(await t.runs.getArtifactJson(runId, 'agent-report'), undefined)
    assert.equal((await t.engine.submitDecision('defer', 'approved deferral', 'key', undefined, runId, t.dispatcher)).duplicate, true)
  } finally { await t.close() }
})

test('a terminal claim rejection parks the run blocked so reset can recover', async () => {
  const t = setup(async payload => payload.kind === 'decision-run' ? startResult(payload.sessionId) : completed(payload.sessionId, payload.choice))
  try {
    const { runId } = await t.engine.startRun(false, t.dispatcher)
    await t.engine.dispatchStart(runId, t.dispatcher)
    // Seed a conflicting receipt for this run's decision: the real claim
    // collides (digest mismatch) and is terminal for the recorded decision.
    const conflicting = {
      decisionId: `decision-${runId}`, chosenOption: 'defer', rationale: 'conflicting earlier claim',
      decidedAt: '2026-09-01T00:00:00Z', decisionRequestId: 'request-seed', permittedAction: 'conflicting',
    }
    assert.equal((await t.receipts.claim(conflicting, 'other-successor', decisionDigest(conflicting))).status, 'claimed')
    const submitted = await t.engine.submitDecision('defer', 'approved deferral', 'key', undefined, runId, t.dispatcher)
    assert.equal(submitted.ok, false)
    assert.match(submitted.error!, /^CLAIM_REJECTED:/)
    assert.equal((await t.engine.getState()).state, 'blocked')
    // The retained intent must not wedge reset forever; audit rows survive.
    await t.engine.reset()
    const next = await t.engine.startRun(false, t.dispatcher)
    assert.notEqual(next.runId, runId)
  } finally { await t.close() }
})

test('a completion whose effect violates the approved choice is rejected, nothing synthesized', async () => {
  const t = setup(async payload => {
    if (payload.kind === 'decision-run') return startResult(payload.sessionId)
    // Well-formed envelope, but the runtime claims it executed a different
    // action than the human approved.
    return { ok: true, result: { status: 'COMPLETED', decisionId: `decision-svc-${payload.sessionId}`, receiptId: 'runtime-receipt', invocationB: 'runtime-successor', effect: { effect: 'create_draft_pr', mode: 'dry-run', noExternalMutationPerformed: true, authorizedBy: { decisionId: `decision-svc-${payload.sessionId}`, consumptionReceiptId: 'runtime-receipt', successorInvocationId: 'runtime-successor' } } } }
  })
  try {
    const { runId } = await t.engine.startRun(false, t.dispatcher)
    await t.engine.dispatchStart(runId, t.dispatcher)
    const submitted = await t.engine.submitDecision('defer', 'approved deferral', 'key', undefined, runId, t.dispatcher)
    assert.equal(submitted.ok, false)
    assert.match(submitted.error!, /AGENT_RESUME_NOT_COMPLETED/)
    const state = await t.engine.getState()
    assert.equal(state.state, 'blocked')
    assert.equal(state.effect, null)
    assert.equal(await t.runs.getArtifactJson(runId, 'effect-receipt'), undefined)
  } finally { await t.close() }
})

test('a transient persistence failure of the confirmed resume retries and completes', async () => {
  const t = setup(async payload => payload.kind === 'decision-run' ? startResult(payload.sessionId) : completed(payload.sessionId, payload.choice))
  try {
    const originalStore = t.runs.storeArtifact.bind(t.runs)
    let failures = 0
    t.runs.storeArtifact = async (artifact: { name?: string }) => {
      if (artifact.name === 'agent-resume' && failures < 2) {
        failures++
        throw new Error('synthetic transient write failure')
      }
      return originalStore(artifact as Parameters<typeof originalStore>[0])
    }
    const { runId } = await t.engine.startRun(false, t.dispatcher)
    await t.engine.dispatchStart(runId, t.dispatcher)
    assert.equal((await t.engine.submitDecision('defer', 'approved deferral', 'key', undefined, runId, t.dispatcher)).ok, true)
    assert.equal(failures, 2, 'both transient failures must have been absorbed by the bounded retry')
    assert.equal((await t.engine.getState()).state, 'completed')
  } finally { await t.close() }
})

test('a resuming run with no confirmation artifact stays resettable', async () => {
  const t = setup(async payload => payload.kind === 'decision-run' ? startResult(payload.sessionId) : completed(payload.sessionId, payload.choice))
  try {
    const originalStore = t.runs.storeArtifact.bind(t.runs)
    t.runs.storeArtifact = async (artifact: { name?: string }) => {
      if (artifact.name === 'agent-resume') throw new Error('sustained synthetic outage')
      return originalStore(artifact as Parameters<typeof originalStore>[0])
    }
    const { runId } = await t.engine.startRun(false, t.dispatcher)
    await t.engine.dispatchStart(runId, t.dispatcher)
    await assert.rejects(t.engine.submitDecision('defer', 'approved deferral', 'key', undefined, runId, t.dispatcher), /sustained synthetic outage/)
    assert.equal((await t.engine.getState()).state, 'resuming')
    // No confirmation artifact exists, so there is no repair evidence and
    // no in-flight reservation worth protecting — reset is the recovery.
    await t.engine.reset()
    const next = await t.engine.startRun(false, t.dispatcher)
    assert.notEqual(next.runId, runId)
  } finally { await t.close() }
})

test('a phase-A response not bound to this run never opens the human gate', async () => {
  const t = setup(async payload => payload.kind === 'decision-run'
    ? { ok: true, result: { status: 'DECISION_REQUIRED', decisionId: 'decision-svc-someone-else', invocationA: 'stale-invocation', decisionRequest: { patchId: `${f.package}-${f.to_version}`, question: f.decision_request.question, options: f.decision_request.options } } }
    : completed(payload.sessionId, payload.choice))
  try {
    const { runId } = await t.engine.startRun(false, t.dispatcher)
    assert.equal((await t.engine.dispatchStart(runId, t.dispatcher)).ok, false)
    assert.equal((await t.engine.getState()).state, 'blocked')
    assert.equal((await t.engine.getState()).decisionRequest, null)
  } finally { await t.close() }
})
