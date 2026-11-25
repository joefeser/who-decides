/* Bridge duplicate-resume probe tests (P3): the console gate-proof for
 * bridge runs — a second resume must re-execute nothing and its verdict
 * persists on the run's receipts. Run: npm run test:bridge-probe (and
 * included in npm test via test:bridge). */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import type { NextRequest } from 'next/server'
import { ConsoleEngine } from './state'
import type { OutboxDispatcher } from './outbox'
import { POST as resumeRoute } from '../../app/api/bridge/resume/route'

const CHANNEL = { sessionReference: 'op-session-deadbeefdeadbeef', authEventRef: 'op-passcode-login:2026-11-01T00:00:00.000Z' }
const PRINCIPAL = { principal: 'machine:chopin-bridge', credentialRef: 'machine-token-0123456789abcdef' }

function envelope(): Record<string, unknown> {
  return {
    schema: 'who-decides.decision-request.v0',
    sourceSystem: 'chopin',
    question: 'Approve the dependency upgrade implementation graph?',
    options: [{ id: 'approve' }, { id: 'send_back' }],
    coordination: { documentId: 'https://chopin.test/d/abc123', questionId: 'runtime-floor', revision: 7 },
    contextRefs: ['chopin:doc:abc123'],
    digests: [{ algorithm: 'sha256', value: 'a'.repeat(64), of: 'draft-graph' }],
  }
}

function freshEngine(bridgeDispatcher?: OutboxDispatcher): { engine: ConsoleEngine, dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'wd-bridge-probe-test-'))
  process.env.WD_CONSOLE_DIR = dir
  return { engine: new ConsoleEngine('default', { ...(bridgeDispatcher ? { bridgeDispatcher } : {}) }), dir }
}

async function cleanup(dir: string, engine: ConsoleEngine): Promise<void> {
  delete process.env.WD_CONSOLE_DIR
  await engine.close()
  rmSync(dir, { recursive: true, force: true })
}

async function decide(engine: ConsoleEngine): Promise<string> {
  const intake = await engine.startBridgeRun(envelope(), PRINCIPAL)
  if (!intake.ok) throw new Error(`intake failed: ${intake.error}`)
  const result = await engine.submitDecision('approve', 'counters and digest verified', 'key-1', CHANNEL)
  if (!result.ok) throw new Error(`decision failed: ${result.error}`)
  return intake.runId
}

function receiver() {
  const calls: Array<{ opKey: string }> = []
  const dispatch: OutboxDispatcher = async op => {
    calls.push({ opKey: op.opKey })
    return { kind: 'confirmed', result: { state: 'answered', settled: 'approve' } }
  }
  return { dispatch, calls }
}

test('a duplicate-resume probe on a confirmed run re-executes NOTHING and records REJECTED', async () => {
  const rcv = receiver()
  const { engine, dir } = freshEngine(rcv.dispatch)
  try {
    const runId = await decide(engine)
    assert.equal(rcv.calls.length, 1, 'decision-time dispatch hit the wire once')

    const probe = await engine.probeBridgeDuplicateResume(runId, 'op-session-probe0feed')
    assert.equal(probe.attemptedBy, 'op-session-probe0feed')
    assert.ok(probe.result.startsWith('REJECTED'), `gate verdict: ${probe.result}`)
    assert.ok(probe.detail.includes('never re-hit'), 'the receipt names the proof: wire untouched')

    // The outbox gate held: the configured transport saw NO second call.
    assert.equal(rcv.calls.length, 1, 'the duplicate probe did not touch the wire')

    // The verdict persists on the run's receipts (console renders from state).
    const state = await engine.getState()
    assert.equal(state.replayProbe?.result, probe.result)
    assert.equal(state.replayProbe?.attemptedBy, probe.attemptedBy)
  } finally {
    await cleanup(dir, engine)
  }
})

test('the probe typed-refuses while any op is unresolved — recovery is not proof', async () => {
  const { engine, dir } = freshEngine()
  try {
    const runId = await decide(engine)
    await assert.rejects(
      () => engine.probeBridgeDuplicateResume(runId, 'op-session-x'),
      /PROBE_OPS_UNRESOLVED/,
    )
  } finally {
    await cleanup(dir, engine)
  }
})

test('the probe typed-refuses a run that is not a bridge run', async () => {
  const { engine, dir } = freshEngine()
  try {
    await assert.rejects(
      () => engine.probeBridgeDuplicateResume('run-does-not-exist', 'op-session-x'),
      /PROBE_NOT_A_BRIDGE_RUN/,
    )
  } finally {
    await cleanup(dir, engine)
  }
})

function resume(body: unknown, cookie?: string): Promise<Response> {
  const request = new Request('http://localhost:3100/api/bridge/resume', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  })
  return resumeRoute(request as unknown as NextRequest)
}

test('the probe flag is operator-session-gated: no session is a 401, a session gets the typed verdict', async () => {
  const { engine, dir } = freshEngine()
  process.env.WD_CONSOLE_DIR = dir
  const PASSCODE = 'probe-test-passcode-long'
  process.env.WD_OPERATOR_PASSCODE_HASH = createHash('sha256').update(PASSCODE).digest('hex')
  try {
    const noSession = await resume({ runId: 'run-x', probe: true })
    assert.equal(noSession.status, 401)
    assert.equal((await noSession.json()).error, 'OPERATOR_AUTH_REQUIRED')

    const { loginOperator } = await import('./auth')
    const login = await loginOperator(PASSCODE)
    assert.ok(login.ok)
    const token = login.ok ? login.token : ''
    const cookie = `wd_operator_session=${token}`
    const withSession = await resume({ runId: 'run-does-not-exist', probe: true }, cookie)
    assert.equal(withSession.status, 409)
    assert.equal((await withSession.json()).error, 'PROBE_NOT_A_BRIDGE_RUN')
  } finally {
    delete process.env.WD_OPERATOR_PASSCODE_HASH
    await cleanup(dir, engine)
  }
})
