/* Bridge run-kind tests (A1): strict envelope intake, single-active-run
 * refusal, fixture-bypassing decisions, and operator-channel actor
 * attribution. Run: npm run test:bridge */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import { ConsoleEngine } from './state'
import { parseDecisionRequest } from '../bridge/schemas'

const PRINCIPAL = { principal: 'machine:chopin-bridge', credentialRef: 'machine-token-0123456789abcdef' }
const CHANNEL = { sessionReference: 'op-session-deadbeefdeadbeef', authEventRef: 'op-passcode-login:2026-11-01T00:00:00.000Z' }

function validEnvelope(): Record<string, unknown> {
  return {
    schema: 'who-decides.decision-request.v0',
    sourceSystem: 'chopin',
    question: 'Approve the dependency upgrade implementation graph?',
    options: [{ id: 'approve' }, { id: 'send_back' }, { id: 'defer', label: 'Defer to next session' }],
    contextRefs: ['chopin:doc:abc123', 'chopin:question:runtime-floor'],
    digests: [{ algorithm: 'sha256', value: 'a'.repeat(64), of: 'draft-graph' }],
  }
}

function freshEngine(): { engine: ConsoleEngine, dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'wd-bridge-test-'))
  process.env.WD_CONSOLE_DIR = dir
  return { engine: new ConsoleEngine(), dir }
}

async function cleanup(dir: string, engine: ConsoleEngine): Promise<void> {
  delete process.env.WD_CONSOLE_DIR
  await engine.close()
  rmSync(dir, { recursive: true, force: true })
}

function readArtifact(dir: string, name: string): Record<string, unknown> {
  const db = new Database(path.join(dir, 'state.db'))
  const row = db.prepare('SELECT json FROM artifacts WHERE name = ?').get(name) as { json: string }
  db.close()
  return JSON.parse(row.json) as Record<string, unknown>
}

async function intake(engine: ConsoleEngine, envelope: Record<string, unknown> = validEnvelope()) {
  return await engine.startBridgeRun(envelope, PRINCIPAL)
}

test('envelope validation is strict: extra properties, malformed shapes, and weak digests are rejected', () => {
  const good = parseDecisionRequest(validEnvelope())
  assert.equal(good.valid, true)

  // The envelope structurally cannot carry an actor: extra root props reject.
  const smuggled = parseDecisionRequest({ ...validEnvelope(), actor_id: 'joe', actor: { id: 'joe' } })
  assert.equal(smuggled.valid, false, 'an envelope carrying actor identity must be rejected')

  const cases: Array<[string, unknown]> = [
    ['extra property inside an option', { ...validEnvelope(), options: [{ id: 'a', label: 'A', decided_by: 'joe' }, { id: 'b' }] }],
    ['option without id', { ...validEnvelope(), options: [{ label: 'A' }, { id: 'b' }] }],
    ['single option', { ...validEnvelope(), options: [{ id: 'only' }] }],
    ['digest value not 64-hex', { ...validEnvelope(), digests: [{ algorithm: 'sha256', value: 'xyz' }] }],
    ['digest with unknown algorithm', { ...validEnvelope(), digests: [{ algorithm: 'md5', value: 'a'.repeat(32) }] }],
    ['no context refs', { ...validEnvelope(), contextRefs: [] }],
    ['no digests', { ...validEnvelope(), digests: [] }],
    ['wrong schema const', { ...validEnvelope(), schema: 'who-decides.decision-request.v1' }],
    ['missing question', { ...validEnvelope(), question: undefined }],
    ['non-object body', 'just a string'],
    ['null body', null],
  ]
  for (const [name, value] of cases) {
    const result = parseDecisionRequest(value)
    assert.equal(result.valid, false, `${name} must be rejected`)
    if (!result.valid) assert.ok(result.errors.length > 0, `${name} reports errors`)
  }
})

test('intake creates a bridge run holding the exact envelope, opened at the human gate', async () => {
  const { engine, dir } = freshEngine()
  try {
    const envelope = validEnvelope()
    const result = await intake(engine, envelope)
    assert.equal(result.ok, true)

    const state = await engine.getState()
    assert.equal(state.state, 'decision_required', 'a bridge run opens at the human gate — no running phase')
    assert.equal(state.runKind, 'bridge')
    assert.equal(state.invocationA, null, 'no invocation A exists for a bridge run')
    assert.equal(state.decisionRequest?.question, envelope.question)
    assert.deepEqual(state.decisionRequest?.options, ['approve', 'send_back', 'defer'], 'options are the envelope option IDs')
    assert.equal(state.decisionRequest?.sourceSystem, 'chopin')
    assert.deepEqual(state.decisionRequest?.contextRefs, envelope.contextRefs)
    assert.equal(state.decisionRequest?.humanTerms, undefined, 'no fixture fields are invented for a bridge run')

    // The exact accepted bytes are persisted and both records validate.
    const stored = readArtifact(dir, 'decision-request')
    assert.deepEqual(stored, envelope)
    const intakeRecord = readArtifact(dir, 'bridge-intake') as { principal: string, credentialRef: string, requestDigest: string }
    assert.equal(intakeRecord.principal, 'machine:chopin-bridge')
    assert.equal(intakeRecord.credentialRef, PRINCIPAL.credentialRef)
    const expected = `sha256:${createHash('sha256').update(JSON.stringify(envelope)).digest('hex')}`
    assert.equal(intakeRecord.requestDigest, expected, 'requestDigest covers the exact stored envelope bytes')
    assert.match(intakeRecord.requestDigest, /^sha256:[0-9a-f]{64}$/)
    assert.ok(state.artifacts.every(a => a.valid), 'all bridge artifacts carry a real validation, never a free green check')
    assert.equal(state.milestones[0]?.label, 'intake')
  } finally {
    await cleanup(dir, engine)
  }
})

test('invalid envelopes are refused at the engine boundary before any run exists', async () => {
  const { engine, dir } = freshEngine()
  try {
    const result = await intake(engine, { schema: 'who-decides.decision-request.v0', question: 'q' })
    assert.deepEqual(result, { ok: false, error: 'ENVELOPE_INVALID' })
    assert.equal((await engine.getState()).state, 'ready', 'no run was created')
  } finally {
    await cleanup(dir, engine)
  }
})

test('single-active-run is store-level and refuses in both directions', async () => {
  const { engine, dir } = freshEngine()
  try {
    const first = await intake(engine)
    assert.equal(first.ok, true)

    // A second external request can never merge into the active run.
    const second = await intake(engine)
    assert.deepEqual(second, { ok: false, error: 'ACTIVE_RUN_EXISTS' })

    // Native provisioning must not graft fixture artifacts onto a bridge run.
    await assert.rejects(engine.startRun(), /BRIDGE_RUN_ACTIVE/)

    // Reset archives the bridge run and the slot frees again.
    await engine.reset()
    const after = await intake(engine)
    assert.equal(after.ok, true)
  } finally {
    await cleanup(dir, engine)
  }
})

test('bridge decisions validate against the envelope options, never the fixture', async () => {
  const { engine, dir } = freshEngine()
  try {
    await intake(engine)
    // create_draft_pr is a FIXTURE option; the bridge envelope does not offer it.
    const fixtureChoice = await engine.submitDecision('create_draft_pr', 'fixture option smuggle', 'k1', CHANNEL)
    assert.equal(fixtureChoice.ok, false)
    assert.equal(fixtureChoice.error, 'INVALID_CHOICE')

    const result = await engine.submitDecision('approve', 'graph counters and digest verified', 'key-1', CHANNEL)
    assert.equal(result.ok, true)

    const state = await engine.getState()
    assert.equal(state.state, 'resuming', 'the decision is recorded; the run awaits outbound dispatch (A2)')
    assert.equal(state.decision?.choice, 'approve')
    const decision = readArtifact(dir, 'bridge-decision') as { schema: string, choice: string }
    assert.equal(decision.schema, 'who-decides.bridge-decision.v0')
    assert.equal(decision.choice, 'approve')
  } finally {
    await cleanup(dir, engine)
  }
})

test('actor attribution comes from the operator session channel, never the envelope', async () => {
  for (const channel of [CHANNEL, undefined]) {
    const { engine, dir } = freshEngine()
    try {
      const envelope = validEnvelope()
      await intake(engine, envelope)
      await engine.submitDecision('send_back', 'runtime floor unresolved', 'key-1', channel)

      const decision = readArtifact(dir, 'bridge-decision') as {
        actor: {
          actor_id: string, actor_kind: string, actor_verification_source: string,
          authentication_context: { interaction_channel: string, session_reference: string, auth_event_ref: string, secret_material_present: boolean },
        },
        intakePrincipal: { principal: string },
        evidence: { requestDigest: string },
      }
      // The actor is the session channel that carried the answer…
      assert.equal(decision.actor.actor_kind, 'human')
      assert.equal(decision.actor.authentication_context.session_reference,
        channel?.sessionReference ?? 'demo-unauthenticated-local-console')
      assert.equal(decision.actor.authentication_context.auth_event_ref, channel?.authEventRef ?? 'demo-none')
      assert.equal(decision.actor.actor_verification_source,
        channel ? 'server_session_with_human_interaction' : 'unverified_demo')
      assert.equal(decision.actor.authentication_context.secret_material_present, false)
      // …the machine principal is recorded separately as the delivery channel…
      assert.equal(decision.intakePrincipal.principal, 'machine:chopin-bridge')
      // …and the persisted envelope contains no identity fields at all.
      const stored = readArtifact(dir, 'decision-request')
      assert.ok(!JSON.stringify(stored).includes('actor'), 'the envelope never carries actor data')
      // Evidence cites the exact envelope bytes the decision responds to.
      assert.equal(decision.evidence.requestDigest,
        `sha256:${createHash('sha256').update(JSON.stringify(envelope)).digest('hex')}`)
    } finally {
      await cleanup(dir, engine)
    }
  }
})

test('bridge decision idempotency: same submission replays, a different decision conflicts, crash recovers', async () => {
  const { engine, dir } = freshEngine()
  try {
    await intake(engine)
    const first = await engine.submitDecision('approve', 'verified', 'key-1', CHANNEL)
    assert.equal(first.ok, true)

    const retry = await engine.submitDecision('approve', 'verified', 'key-1', CHANNEL)
    assert.equal(retry.ok, true)
    assert.equal(retry.duplicate, true, 'same key+choice is idempotent success')

    const conflict = await engine.submitDecision('defer', 'changed my mind', 'key-2', CHANNEL)
    assert.equal(conflict.ok, false)
    assert.equal(conflict.error, 'DECISION_ALREADY_RECORDED', 'the first decision was consumed')

    // Crash window: intent persisted, phase write lost. The retry repairs
    // from the stored intent — same choice, same channel, no new artifacts.
    const db = new Database(path.join(dir, 'state.db'))
    db.prepare("UPDATE runs SET state = 'decision_required'").run()
    db.close()
    const repair = await engine.submitDecision('approve', 'verified', 'key-1', CHANNEL)
    assert.equal(repair.ok, true)
    assert.equal((await engine.getState()).state, 'resuming')
  } finally {
    await cleanup(dir, engine)
  }
})

test('bridge runs never advance on wall-clock', async () => {
  const { engine, dir } = freshEngine()
  try {
    await intake(engine)
    await engine.submitDecision('approve', 'approved', 'k', CHANNEL)
    const db = new Database(path.join(dir, 'state.db'))
    db.prepare('UPDATE runs SET phase_changed_at = ?').run(new Date(Date.now() - 60_000).toISOString())
    db.close()
    assert.equal((await engine.getState()).state, 'resuming', 'no wall-clock completion for a bridge run')
  } finally {
    await cleanup(dir, engine)
  }
})

test('native runs keep their fixture decision request (no regression)', async () => {
  const { engine, dir } = freshEngine()
  try {
    await engine.startRun()
    const db = new Database(path.join(dir, 'state.db'))
    db.prepare('UPDATE runs SET phase_changed_at = ?').run(new Date(Date.now() - 10_000).toISOString())
    db.close()
    const state = await engine.getState()
    assert.equal(state.runKind, 'native')
    assert.equal(state.state, 'decision_required')
    assert.equal(typeof state.decisionRequest?.humanTerms, 'string', 'fixture fields still render for native runs')
    assert.equal(typeof state.decisionRequest?.tradeoffFindingId, 'string')
  } finally {
    await cleanup(dir, engine)
  }
})
