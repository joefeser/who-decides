/* Bridge record tests (A3): the who-decides.bridge-record.v0 receipt —
 * unknown-choice rejection, boundary enforcement, confirmed-only writes,
 * and the dry-run/native paths unchanged. Run: npm run test:bridge-record */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import { ConsoleEngine } from './state'
import type { OutboxDispatcher } from './outbox'
import { buildBridgeRecord } from '../artifacts/build'

const CHANNEL = { sessionReference: 'op-session-deadbeefdeadbeef', authEventRef: 'op-passcode-login:2026-11-01T00:00:00.000Z' }
const PRINCIPAL = { principal: 'machine:chopin-bridge', credentialRef: 'machine-token-0123456789abcdef' }
const sha256 = (v: string) => createHash('sha256').update(v).digest('hex')

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
  const dir = mkdtempSync(path.join(tmpdir(), 'wd-record-test-'))
  process.env.WD_CONSOLE_DIR = dir
  return { engine: new ConsoleEngine('default', { ...(bridgeDispatcher ? { bridgeDispatcher } : {}) }), dir }
}

async function cleanup(dir: string, engine: ConsoleEngine): Promise<void> {
  delete process.env.WD_CONSOLE_DIR
  await engine.close()
  rmSync(dir, { recursive: true, force: true })
}

const confirming: OutboxDispatcher = async () => ({ kind: 'confirmed', result: { state: 'answered', settled: 'approve' } })

function readArtifact(dir: string, name: string): Record<string, unknown> {
  const db = new Database(path.join(dir, 'state.db'))
  const row = db.prepare('SELECT json FROM artifacts WHERE name = ?').get(name) as { json: string }
  db.close()
  return JSON.parse(row.json) as Record<string, unknown>
}

function recordInput(overrides: Partial<Parameters<typeof buildBridgeRecord>[0]> = {}) {
  return {
    runId: 'run-x',
    targetSystem: 'chopin',
    operation: 'answer',
    idempotencyKey: 'wd:run-x:answer',
    payloadJson: '{"tool":"answer_decision","arguments":{"id":"d","questionId":"q","revision":7,"optionIds":["approve"],"idempotencyKey":"wd:run-x:answer"}}',
    resultJson: JSON.stringify({ outcome: 'confirmed', result: { state: 'answered', settled: 'approve' } }),
    choice: 'approve',
    envelopeOptionIds: ['approve', 'send_back'],
    channel: CHANNEL,
    recordedAt: '2026-11-01T12:00:00.000Z',
    ...overrides,
  }
}

test('the builder rejects unknown choices and unknown operations typed (build.ts discipline)', () => {
  const good = buildBridgeRecord(recordInput())
  assert.equal(good.schema, 'who-decides.bridge-record.v0')

  assert.throws(() => buildBridgeRecord(recordInput({ choice: 'create_draft_pr' })), /UNKNOWN_CHOICE:create_draft_pr/,
    'a choice outside the envelope options is never half-recorded')
  assert.throws(() => buildBridgeRecord(recordInput({ choice: '' })), /UNKNOWN_CHOICE:/)
  assert.throws(() => buildBridgeRecord(recordInput({ operation: 'delete_everything' })), /UNKNOWN_OPERATION:delete_everything/)
})

test('the builder digests the exact persisted bytes — payload and result', () => {
  const input = recordInput()
  const record = buildBridgeRecord(input) as { payloadDigest: string, resultDigest: string }
  assert.equal(record.payloadDigest, `sha256:${sha256(input.payloadJson)}`)
  assert.equal(record.resultDigest, `sha256:${sha256(input.resultJson)}`)
})

test('a confirmed op writes exactly one bridge record, idempotent across repeated dispatches', async () => {
  const { engine, dir } = freshEngine()
  try {
    const intake = await engine.startBridgeRun(envelope(), PRINCIPAL)
    if (!intake.ok) throw new Error('intake failed')
    await engine.submitDecision('approve', 'counters verified', 'key-1', CHANNEL)

    // No record before confirmation.
    const db0 = new Database(path.join(dir, 'state.db'))
    assert.equal((db0.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE kind = 'bridge-record'").get() as { n: number }).n, 0)
    db0.close()

    await engine.dispatchBridgeOps(intake.runId, confirming)
    const record = readArtifact(dir, `bridge-record:wd:${intake.runId}:answer`) as {
      targetSystem: string, operation: string, idempotencyKey: string,
      payloadDigest: string, resultDigest: string, choice: string,
      approverAsAssertedByBridge: Record<string, string>,
    }
    assert.equal(record.targetSystem, 'chopin')
    assert.equal(record.operation, 'answer')
    assert.equal(record.idempotencyKey, `wd:${intake.runId}:answer`)
    assert.match(record.payloadDigest, /^sha256:[0-9a-f]{64}$/)
    assert.match(record.resultDigest, /^sha256:[0-9a-f]{64}$/)
    assert.equal(record.choice, 'approve')
    // Approver AS ASSERTED BY BRIDGE: the operator session channel, labeled.
    assert.equal(record.approverAsAssertedByBridge.assertedBy, 'who-decides')
    assert.equal(record.approverAsAssertedByBridge.actor_id, CHANNEL.sessionReference)
    assert.equal(record.approverAsAssertedByBridge.session_reference, CHANNEL.sessionReference)
    assert.equal(record.approverAsAssertedByBridge.auth_event_ref, CHANNEL.authEventRef)
    assert.equal(record.approverAsAssertedByBridge.actor_kind, 'human')

    // Repeated dispatch (echo) does not duplicate the record.
    await engine.dispatchBridgeOps(intake.runId, confirming)
    const db = new Database(path.join(dir, 'state.db'))
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE kind = 'bridge-record'").get() as { n: number }).n, 1)
    db.close()
    // And the stored record is listed with a real validation flag.
    const state = await engine.getState()
    const listed = state.artifacts.find(a => a.name === `bridge-record:wd:${intake.runId}:answer`)
    assert.ok(listed?.valid, 'the record carries a real validation, never a free green check')
  } finally {
    await cleanup(dir, engine)
  }
})

test('unconfirmed ops never get records: unknown stays unknown, failed keeps its typed error', async () => {
  const { engine, dir } = freshEngine()
  try {
    const intake = await engine.startBridgeRun(envelope(), PRINCIPAL)
    if (!intake.ok) throw new Error('intake failed')
    await engine.submitDecision('approve', 'counters verified', 'key-1', CHANNEL)

    await engine.dispatchBridgeOps(intake.runId, async () => ({ kind: 'unknown', detail: 'lost' }))
    await engine.dispatchBridgeOps(intake.runId, async () => ({ kind: 'failed', error: 'stale' }))
    const db = new Database(path.join(dir, 'state.db'))
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE kind = 'bridge-record'").get() as { n: number }).n, 0,
      'a receipt never asserts what was not confirmed')
    db.close()
  } finally {
    await cleanup(dir, engine)
  }
})

test('boundary fields are enforced: the store refuses malformed records', async () => {
  const { engine, dir } = freshEngine(confirming)
  try {
    const intake = await engine.startBridgeRun(envelope(), PRINCIPAL)
    if (!intake.ok) throw new Error('intake failed')
    await engine.submitDecision('approve', 'counters verified', 'key-1', CHANNEL)
    // The inline dispatcher confirmed + wrote the record; tamper it and
    // prove the validator bites via a direct re-store attempt.
    const db = new Database(path.join(dir, 'state.db'))
    const name = `bridge-record:wd:${intake.runId}:answer`
    const stored = db.prepare('SELECT json FROM artifacts WHERE name = ?').get(name) as { json: string }
    const record = JSON.parse(stored.json) as Record<string, unknown>
    db.close()

    // Direct validator probes on boundary violations of every enforced field.
    const store = (engine as unknown as { storeArtifact(runId: string, name: string, kind: string, artifact: unknown): Promise<void> }).storeArtifact
    const probes: Array<[string, Record<string, unknown>]> = [
      ['wrong schema const', { ...record, schema: 'who-decides.bridge-record.v1' }],
      ['non-hex payload digest', { ...record, payloadDigest: 'sha256:xyz' }],
      ['short result digest', { ...record, resultDigest: 'sha256:abc' }],
      ['empty choice', { ...record, choice: '' }],
      ['unknown operation', { ...record, operation: 'execute' }],
      ['missing approver', { ...record, approverAsAssertedByBridge: undefined }],
      ['wrong assertedBy', { ...record, approverAsAssertedByBridge: { ...record.approverAsAssertedByBridge as object, assertedBy: 'chopin' } }],
      ['machine actor_kind', { ...record, approverAsAssertedByBridge: { ...record.approverAsAssertedByBridge as object, actor_kind: 'machine' } }],
      ['empty session ref', { ...record, approverAsAssertedByBridge: { ...record.approverAsAssertedByBridge as object, session_reference: '' } }],
    ]
    for (const [label, broken] of probes) {
      await assert.rejects(store(intake.runId, `probe:${label}`, 'bridge-record', broken), /ARTIFACT_INVALID/, `${label} must fail the write`)
    }
  } finally {
    await cleanup(dir, engine)
  }
})

test('the bridge run produces NO HACP-schema artifacts; the dry-run receipt path for native runs is unchanged', async () => {
  // Bridge side: every persisted artifact of a completed bridge decision is
  // a bridge schema or dispatch envelope — no hacp_version anywhere.
  const bridgeEngine = freshEngine(confirming)
  try {
    const intake = await bridgeEngine.engine.startBridgeRun(envelope(), PRINCIPAL)
    if (!intake.ok) throw new Error('intake failed')
    await bridgeEngine.engine.submitDecision('approve', 'counters verified', 'key-1', CHANNEL)
    const db = new Database(path.join(bridgeEngine.dir, 'state.db'))
    const artifacts = db.prepare('SELECT name, json FROM artifacts').all() as Array<{ name: string, json: string }>
    db.close()
    assert.ok(artifacts.length > 0)
    for (const a of artifacts) {
      assert.ok(!a.json.includes('hacp_version') && !a.json.includes('record_kind'), `${a.name} is explicitly non-HACP`)
    }
  } finally {
    await cleanup(bridgeEngine.dir, bridgeEngine.engine)
  }

  // Native side: the deterministic dry-run spine is untouched — same
  // artifacts, same receipt kinds, still green.
  const native = freshEngine()
  try {
    await native.engine.startRun()
    const db = new Database(path.join(native.dir, 'state.db'))
    db.prepare('UPDATE runs SET phase_changed_at = ?').run(new Date(Date.now() - 10_000).toISOString())
    db.close()
    const result = await native.engine.submitDecision('create_draft_pr', 'approved', 'key-1')
    assert.equal(result.ok, true)
    const state = await native.engine.getState()
    const kinds = state.artifacts.map(a => a.kind)
    assert.ok(kinds.includes('human-decision') && kinds.includes('agent-report'), 'the HACP spine still builds for native runs')
    assert.ok(state.artifacts.every(a => a.valid), 'native artifacts all validate — dry-run path unchanged')
    assert.ok(!kinds.includes('bridge-record') && !kinds.includes('bridge-decision'), 'no bridge records on native runs')
    assert.equal(state.outbox.length, 0, 'no outbox ops on native runs')
  } finally {
    await cleanup(native.dir, native.engine)
  }
})
