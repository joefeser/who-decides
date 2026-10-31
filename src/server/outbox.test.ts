/* Outbox tests (A2): the one-transaction rule, exact-payload replay,
 * unknown-outcome retention, same-key retry semantics, and the untouched
 * refusal probe. Run: npm run test:outbox */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { ConsoleEngine } from './state'
import type { OutboxDispatcher, OutboxDispatchOutcome } from './outbox'
import type { OutboxOpRow } from './store/store'

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
  const dir = mkdtempSync(path.join(tmpdir(), 'wd-outbox-test-'))
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

function ops(dir: string): OutboxOpRow[] {
  const db = new Database(path.join(dir, 'state.db'))
  const rows = db.prepare('SELECT * FROM outbox_ops').all() as OutboxOpRow[]
  db.close()
  return rows
}

/** A receiver fake with B4's discipline: an identical retry replays the
 * ORIGINAL result; calls are recorded so tests can assert exact payloads. */
function receiver(originalResult: Record<string, unknown> = { state: 'answered', settled: 'approve' }) {
  const calls: Array<{ opKey: string, payload: unknown }> = []
  let answered = false
  const dispatch: OutboxDispatcher = async op => {
    calls.push({ opKey: op.opKey, payload: op.payload })
    if (!answered) {
      answered = true
      return { kind: 'confirmed', result: originalResult }
    }
    // Same key again: B4 replays the original result.
    return { kind: 'confirmed', result: originalResult }
  }
  return { dispatch, calls }
}

test('the decision and its outbound intent commit together (one transaction)', async () => {
  const { engine, dir } = freshEngine()
  try {
    const runId = await decide(engine)
    const rows = ops(dir)
    assert.equal(rows.length, 1, 'exactly one outbound op — the answer')
    const op = rows[0]!
    assert.equal(op.kind, 'answer')
    assert.equal(op.target_system, 'chopin')
    assert.equal(op.status, 'pending', 'no transport was wired: intent committed, dispatch not yet attempted')
    assert.equal(op.op_key, `wd:${runId}:answer`)
    // The payload mirrors the fork's answer_decision contract, built ONLY
    // from the persisted intake envelope + recorded choice.
    assert.deepEqual(JSON.parse(op.payload_json), {
      tool: 'answer_decision',
      arguments: {
        id: 'https://chopin.test/d/abc123',
        questionId: 'runtime-floor',
        revision: 7,
        optionIds: ['approve'],
        idempotencyKey: `wd:${runId}:answer`,
      },
    })
    // And the decision row exists — they committed together.
    const db = new Database(path.join(dir, 'state.db'))
    const run = db.prepare('SELECT decision_json FROM runs WHERE id = ?').get(runId) as { decision_json: string }
    db.close()
    assert.ok(run.decision_json, 'the decision intent is recorded in the same commit')
    // Surface: getState lists the op for the console.
    assert.equal((await engine.getState()).outbox.length, 1)
  } finally {
    await cleanup(dir, engine)
  }
})

test('a decision that fails before the intent commits enqueues NOTHING', async () => {
  const { engine, dir } = freshEngine()
  try {
    const intake = await engine.startBridgeRun(envelope(), PRINCIPAL)
    if (!intake.ok) throw new Error('intake failed')
    const invalid = await engine.submitDecision('create_draft_pr', 'fixture option', 'k', CHANNEL)
    assert.equal(invalid.ok, false)
    assert.equal(ops(dir).length, 0, 'no decision, no dispatch intent — neither can exist alone')
  } finally {
    await cleanup(dir, engine)
  }
})

test('intent-without-dispatch resumes with the exact persisted payload', async () => {
  const { engine, dir } = freshEngine()
  try {
    const runId = await decide(engine)
    const before = ops(dir)[0]!

    const rcv = receiver()
    const result = await engine.dispatchBridgeOps(runId, rcv.dispatch)
    assert.equal(result.ok, true)
    assert.equal(result.outcomes?.[0]?.status, 'confirmed')

    assert.equal(rcv.calls.length, 1)
    assert.deepEqual(rcv.calls[0]!.payload, JSON.parse(before.payload_json), 'the dispatcher received the exact persisted bytes')
    // "The world moved on": a fresh read would now say revision 8. The
    // outbox replays the INTAKE-TIME revision — never a fresh read.
    const args = (rcv.calls[0]!.payload as { arguments: { revision: number } }).arguments
    assert.equal(args.revision, 7, 'the intake-time revision is replayed, not refreshed')

    const after = ops(dir)[0]!
    assert.equal(after.status, 'confirmed')
    assert.deepEqual(JSON.parse(after.result_json!), { outcome: 'confirmed', result: { state: 'answered', settled: 'approve' } })
  } finally {
    await cleanup(dir, engine)
  }
})

test('a lost response resolves unknown — retained, never guessed up or down', async () => {
  const { engine, dir } = freshEngine()
  try {
    const runId = await decide(engine)
    // The transport reports: sent, no response (crash window after the
    // receiver may have acted).
    const lost: OutboxDispatcher = async () => ({ kind: 'unknown', detail: 'no response before disconnect' })
    const first = await engine.dispatchBridgeOps(runId, lost)
    assert.equal(first.outcomes?.[0]?.status, 'unknown')

    const op = ops(dir)[0]!
    assert.equal(op.status, 'unknown')
    assert.deepEqual(JSON.parse(op.result_json!), { outcome: 'unknown', detail: 'no response before disconnect' })
    assert.equal((await engine.getState()).outbox[0]?.status, 'unknown', 'the console shows unknown — not success, not failure')

    // A still-silent retry keeps it unknown.
    const second = await engine.dispatchBridgeOps(runId, lost)
    assert.equal(second.outcomes?.[0]?.status, 'unknown')
    assert.equal(ops(dir)[0]!.status, 'unknown')
  } finally {
    await cleanup(dir, engine)
  }
})

test('same-key retry returns the original result when the receiver confirms', async () => {
  const { engine, dir } = freshEngine()
  try {
    const runId = await decide(engine)
    const original = { state: 'answered', settled: 'approve', revision: 7 }
    // First attempt: the receiver acted, but the response was lost.
    let call = 0
    const flaky: OutboxDispatcher = async () => {
      call += 1
      return call === 1 ? { kind: 'unknown', detail: 'response lost' } : { kind: 'confirmed', result: original }
    }
    await engine.dispatchBridgeOps(runId, flaky)
    assert.equal(ops(dir)[0]!.status, 'unknown')

    // Retry with a working transport: the receiver's idempotency replays
    // the ORIGINAL result under the same key.
    const retry = await engine.dispatchBridgeOps(runId, flaky)
    assert.equal(retry.outcomes?.[0]?.status, 'confirmed')
    const op = ops(dir)[0]!
    assert.equal(op.status, 'confirmed')
    assert.deepEqual(JSON.parse(op.result_json!).result, original, 'the ORIGINAL result is what lands, not a fresh one')
    assert.equal(call, 2)
  } finally {
    await cleanup(dir, engine)
  }
})

test('terminal ops are never re-dispatched; their persisted results are echoed', async () => {
  const { engine, dir } = freshEngine()
  try {
    const runId = await decide(engine)
    const rcv = receiver()
    await engine.dispatchBridgeOps(runId, rcv.dispatch)
    assert.equal(rcv.calls.length, 1)

    const again = await engine.dispatchBridgeOps(runId, rcv.dispatch)
    assert.equal(again.outcomes?.[0]?.status, 'confirmed')
    assert.equal(again.outcomes?.[0]?.replayed, true)
    assert.equal(rcv.calls.length, 1, 'a confirmed op never touches the wire again')
    assert.equal(ops(dir)[0]!.status, 'confirmed')
  } finally {
    await cleanup(dir, engine)
  }
})

test('a typed receiver refusal resolves failed with the typed error retained', async () => {
  const { engine, dir } = freshEngine()
  try {
    const runId = await decide(engine)
    const refusing: OutboxDispatcher = async () => ({ kind: 'failed', error: 'stale-revision (current 8)' })
    const result = await engine.dispatchBridgeOps(runId, refusing)
    assert.equal(result.outcomes?.[0]?.status, 'failed')
    const op = ops(dir)[0]!
    assert.equal(op.status, 'failed')
    assert.deepEqual(JSON.parse(op.result_json!), { outcome: 'failed', error: 'stale-revision (current 8)' })
    // Failed is terminal too.
    const rcv = receiver()
    const echo = await engine.dispatchBridgeOps(runId, rcv.dispatch)
    assert.equal(echo.outcomes?.[0]?.status, 'failed')
    assert.equal(rcv.calls.length, 0)
  } finally {
    await cleanup(dir, engine)
  }
})

test('a wired bridge dispatcher runs inline at decision time', async () => {
  const rcv = receiver()
  const { engine, dir } = freshEngine(rcv.dispatch)
  try {
    const runId = await decide(engine)
    assert.equal(rcv.calls.length, 1, 'the decision path dispatched inline')
    assert.equal(ops(dir)[0]!.status, 'confirmed')
    assert.equal((await engine.getState()).outbox[0]?.status, 'confirmed')
    assert.equal(rcv.calls[0]!.opKey, `wd:${runId}:answer`)
  } finally {
    await cleanup(dir, engine)
  }
})

test('a retrying decision never double-enqueues: the deterministic op key collapses it', async () => {
  const { engine, dir } = freshEngine()
  try {
    await decide(engine)
    // Crash window: phase write lost — the run looks decision_required again.
    const db = new Database(path.join(dir, 'state.db'))
    db.prepare("UPDATE runs SET state = 'decision_required'").run()
    db.close()
    const repair = await engine.submitDecision('approve', 'counters and digest verified', 'key-1', CHANNEL)
    assert.equal(repair.ok, true)
    assert.equal(ops(dir).length, 1, 'the repair reuses the persisted op — one row, same key, same payload')
  } finally {
    await cleanup(dir, engine)
  }
})

test('dispatchBridgeOps refuses non-bridge and missing runs typed', async () => {
  const { engine, dir } = freshEngine()
  try {
    const rcv = receiver()
    const none = await engine.dispatchBridgeOps('run-does-not-exist', rcv.dispatch)
    assert.equal(none.ok, false)
    assert.equal(none.error, 'RUN_CHANGED')

    await engine.startRun()
    const native = await engine.dispatchBridgeOps((await engine.getState()).runId, rcv.dispatch)
    assert.equal(native.ok, false)
    assert.equal(native.error, 'NOT_A_BRIDGE_RUN')
  } finally {
    await cleanup(dir, engine)
  }
})

test('/api/replay stays a refusal probe: it never dispatches outbox ops', async () => {
  const { engine, dir } = freshEngine()
  try {
    const runId = await decide(engine)
    const rcv = receiver()
    // The probe on a bridge run: no consumption receipt exists to attack,
    // and crucially it never touches the outbox.
    await assert.rejects(engine.attemptDuplicateReplay(), /NOT_RESUMED_YET/)
    assert.equal(rcv.calls.length, 0)
    assert.equal(ops(dir)[0]!.status, 'pending', 'the op is untouched by the probe')
    // And the replay route file is byte-identical to dev (untouched slice).
    const { execFileSync } = await import('node:child_process')
    const diff = execFileSync('git', ['diff', '--name-only', 'dev...HEAD', '--', 'app/api/replay/route.ts'], { cwd: process.cwd() }).toString()
    assert.equal(diff.trim(), '', 'app/api/replay/route.ts is not modified by this slice')
  } finally {
    await cleanup(dir, engine)
  }
})
