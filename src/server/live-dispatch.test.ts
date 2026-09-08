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

function setup(invoke: (payload: Record<string, unknown>) => Promise<Record<string, unknown>>) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wd-live-console-'))
  const runs = new SqliteRunStore(dir)
  const engine = new ConsoleEngine('live-test', { runs, receipts: new SqliteReceiptStore(path.join(dir, 'consumption.db')) })
  const dispatcher = createAgentDispatcher({ endpoint: 'synthetic-runtime', machineToken: 'synthetic-token' }, { invoke })
  return { engine, runs, dispatcher, dir, close: async () => { await engine.close(); rmSync(dir, { recursive: true, force: true }) } }
}
const startResult = () => ({ ok: true, result: { status: 'DECISION_REQUIRED', decisionRequest: { patchId: `${f.package}-${f.to_version}`, question: f.decision_request.question, options: f.decision_request.options } } })
const completed = (sessionId: unknown) => ({ ok: true, result: { status: 'COMPLETED', decisionId: `decision-svc-${sessionId}`, receiptId: 'runtime-receipt', invocationB: 'runtime-successor' } })
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
    if (payload.kind === 'decision-run') return startResult()
    resumes++; entered(); await held
    return completed(payload.sessionId)
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
  const t = setup(async payload => payload.kind === 'decision-run' ? startResult() : { ok: false, error: 'synthetic resume failure' })
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
  const t = setup(async () => startResult())
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
