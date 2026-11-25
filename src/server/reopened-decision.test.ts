import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { reopenedRequest } from './reopened-decision'
import { ConsoleEngine } from './state'
import { SqliteRunStore } from './store/sqlite-run-store'
import { SqliteReceiptStore } from './store/sqlite-receipt-store'

const env = { schema: 'who-decides.decision-request.v0', sourceSystem: 'chopin', question: 'Continue?', options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }], coordination: { documentId: 'doc', questionId: 'card', revision: 0 }, contextRefs: ['chopin:doc:doc'], digests: [{ algorithm: 'sha256', value: 'a'.repeat(64) }] }
const settled = { choices: ['yes'], by: 'bridge', at: '2026-11-25T15:25:50.000Z' }
const snapshot = () => ({ decisions: [{ id: 'card', status: 'reopened', revision: 0, previous: settled, questions: [{ id: 'inner', question: 'Continue?', multiple: false, options: env.options }] }] })
const confirmed = { outcome: 'confirmed', result: { settled } }
const principal = { principal: 'machine:chopin-bridge', credentialRef: 'machine-token-0123456789abcdef' }
const channel = { sessionReference: 'op-session-deadbeefdeadbeef', authEventRef: 'op-passcode-login:2026-11-25T00:00:00.000Z' }

test('same revision is a fresh cycle only with matching attributed previous settlement', () => {
  const result = reopenedRequest(env, snapshot(), confirmed, 'prior')
  assert.equal(result.envelope.coordination.revision, 0)
  assert.ok(result.envelope.contextRefs.includes('who-decides:prior-run:prior'))
  for (const field of ['by', 'at', 'choices'] as const) {
    const bad = structuredClone(snapshot())
    Object.assign(bad.decisions[0].previous, { [field]: field === 'choices' ? ['no'] : 'different' })
    assert.throws(() => reopenedRequest(env, bad, confirmed, 'prior'), /MISMATCH/)
  }
  const answered = snapshot(); answered.decisions[0].status = 'answered'
  assert.throws(() => reopenedRequest(env, answered, confirmed, 'prior'), /NOT_REOPENED/)
  const missing = snapshot(); missing.decisions = []
  assert.throws(() => reopenedRequest(env, missing, confirmed, 'prior'), /UNAVAILABLE/)
  const duplicate = snapshot(); duplicate.decisions.push(duplicate.decisions[0])
  assert.throws(() => reopenedRequest(env, duplicate, confirmed, 'prior'), /UNAVAILABLE/)
})

test('concurrent reopen observation preserves old receipt, opens one unanswered cycle and survives restart', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wd-reopen-'))
  const calls: unknown[] = []
  let currentSnapshot = snapshot()
  const create = () => new ConsoleEngine('test', { runs: new SqliteRunStore(dir), receipts: new SqliteReceiptStore(path.join(dir, "consumption.db")), bridgeReader: async () => currentSnapshot, bridgeDispatcher: async op => { calls.push(op.payload); return { kind: 'confirmed', result: { settled: { ...settled, choices: (op.payload as { arguments: { optionIds: string[] } }).arguments.optionIds } } } } })
  let engine = create()
  try {
    const first = await engine.startBridgeRun(env, principal); assert.ok(first.ok)
    await assert.rejects(engine.observeReopenedDecision(first.runId), /UNCONFIRMED/)
    assert.ok((await engine.submitDecision('yes', 'first human choice', 'original', channel)).ok)
    const original = await engine.getState()
    const results = await Promise.all([engine.observeReopenedDecision(first.runId), engine.observeReopenedDecision(first.runId)])
    assert.equal(results[0].runId, results[1].runId)
    const next = await engine.getState()
    assert.equal(next.state, 'decision_required'); assert.equal(next.decision, null); assert.equal(next.outbox.length, 0)
    assert.equal(calls.length, 1)
    assert.equal((await engine.resumeBridgeOps(first.runId)).error, 'RUN_CHANGED')
    await engine.close(); engine = create()
    assert.equal((await engine.getState()).runId, next.runId)
    assert.equal((await engine.getState()).decision, null)
    currentSnapshot = snapshot(); currentSnapshot.decisions[0].status = 'answered'
    assert.equal((await engine.submitDecision('no', 'stale view', 'stale-choice', channel)).error, 'REOPENED_CARD_CHANGED_OR_UNAVAILABLE')
    assert.equal((await engine.getState()).outbox.length, 0)
    currentSnapshot = snapshot()
    assert.ok((await engine.submitDecision('no', 'new human choice', 'new-choice', channel)).ok)
    const second = await engine.getState()
    assert.notEqual(second.outbox[0].opKey, original.outbox[0].opKey)
    assert.equal(second.decision?.choice, 'no')
    assert.equal(calls.length, 2)
    const db = new Database(path.join(dir, 'state.db'), { readonly: true })
    try {
      assert.equal((db.prepare('SELECT archived FROM runs WHERE id = ?').get(first.runId) as { archived: number }).archived, 1)
      assert.equal((db.prepare('SELECT status FROM outbox_ops WHERE run_id = ?').get(first.runId) as { status: string }).status, 'confirmed')
      assert.ok(db.prepare("SELECT 1 FROM artifacts WHERE run_id = ? AND name = 'bridge-decision'").get(first.runId))
      assert.equal((db.prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number }).n, 2)
    } finally { db.close() }

  } finally { await engine.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('local reconcile route denies an anonymous caller before reading Chopin', async () => {
  const previous = process.env.WD_PROFILE
  process.env.WD_PROFILE = 'private-local'
  try {
    const { POST } = await import('../../app/api/bridge/reconcile/route')
    const response = await POST(new Request('http://localhost/api/bridge/reconcile', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runId: 'run-any' }) }) as import('next/server').NextRequest)
    assert.equal(response.status, 401)
  } finally { if (previous === undefined) delete process.env.WD_PROFILE; else process.env.WD_PROFILE = previous }
})
