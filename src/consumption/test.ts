/* Consumption receipt tests — the spike-log test list:
 * happy claim · identical replay · competing successor rejected ·
 * digest mismatch rejected · expiry ordering · restart survival ·
 * sequential connection/CLI retries. Real overlap: scripts/consumption-proof.mjs.
 * Run: npm run test:consumption */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ConsumptionStore, decisionDigest } from './store'
import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import type { DecisionRecord } from './store'

function sampleDecision(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    decisionId: 'dec-001',
    chosenOption: 'create_draft_pr',
    rationale: 'human approved after reviewing tradeoff',
    decidedAt: '2026-09-03T22:00:00.000Z',
    decisionRequestId: 'req-001',
    permittedAction: 'create draft PR (dry-run receipt)',
    ...overrides,
  }
}

test('happy path: claim once, receipt is immutable and honest', () => {
  const store = new ConsumptionStore(':memory:')
  const result = store.claim(sampleDecision(), 'inv-b')
  assert.equal(result.status, 'claimed')
  if (result.status === 'claimed') {
    assert.match(result.receipt.decisionDigest, /^sha256:[0-9a-f]{64}$/)
    assert.equal(result.receipt.successorInvocationId, 'inv-b')
    assert.match(result.receipt.claimNote, /does not prove/)
  }
  store.close()
})

test('identical replay by the same successor returns the existing claim (recovery)', () => {
  const store = new ConsumptionStore(':memory:')
  const first = store.claim(sampleDecision(), 'inv-b')
  const retry = store.claim(sampleDecision(), 'inv-b')
  assert.equal(first.status, 'claimed')
  assert.equal(retry.status, 'replayed')
  if (first.status === 'claimed' && retry.status === 'replayed') {
    assert.equal(retry.receipt.receiptId, first.receipt.receiptId)
  }
  store.close()
})

test('competing successor is rejected — one decision, one invocation', () => {
  const store = new ConsumptionStore(':memory:')
  store.claim(sampleDecision(), 'inv-b')
  const competitor = store.claim(sampleDecision(), 'inv-c')
  assert.equal(competitor.status, 'rejected')
  if (competitor.status === 'rejected') assert.equal(competitor.reason, 'competing_successor')
  store.close()
})

test('digest mismatch is rejected (integrity basis enforced)', () => {
  const store = new ConsumptionStore(':memory:')
  const result = store.claim(sampleDecision(), 'inv-b', 'sha256:deadbeef')
  assert.equal(result.status, 'rejected')
  if (result.status === 'rejected') assert.equal(result.reason, 'digest_mismatch')
  store.close()
})

test('expired decision is rejected before any claim is written', () => {
  const store = new ConsumptionStore(':memory:')
  const result = store.claim(
    sampleDecision({ expiresAt: new Date(Date.now() - 1000).toISOString() }),
    'inv-b',
  )
  assert.equal(result.status, 'rejected')
  if (result.status === 'rejected') assert.equal(result.reason, 'expired')
  assert.equal(store.getReceipt('dec-001'), undefined)
  store.close()
})

test('restart survival: a fresh store on the same file preserves the claim', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wd-consumption-'))
  const dbPath = path.join(dir, 'consumption.db')
  const first = new ConsumptionStore(dbPath)
  first.claim(sampleDecision(), 'inv-b')
  first.close()
  const reopened = new ConsumptionStore(dbPath)
  const receipt = reopened.getReceipt('dec-001')
  assert.ok(receipt)
  assert.equal(receipt?.successorInvocationId, 'inv-b')
  const competitor = reopened.claim(sampleDecision(), 'inv-z')
  assert.equal(competitor.status, 'rejected')
  reopened.close()
  rmSync(dir, { recursive: true, force: true })
})

test('sequential connections: exactly one winner', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wd-consumption-'))
  const dbPath = path.join(dir, 'consumption.db')
  new ConsumptionStore(dbPath).close()
  const successors = Array.from({ length: 12 }, (_, i) => `inv-${i}`)
  const results = successors.map((id) => {
    const store = new ConsumptionStore(dbPath)
    try {
      return store.claim(sampleDecision(), id)
    } finally {
      store.close()
    }
  })
  const claimed = results.filter(r => r.status === 'claimed')
  const rejected = results.filter(r => r.status === 'rejected' && r.reason === 'competing_successor')
  assert.equal(claimed.length, 1)
  assert.equal(rejected.length, successors.length - 1)
  rmSync(dir, { recursive: true, force: true })
})

test('sequential CLI processes: exactly one winner', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wd-consumption-'))
  const dbPath = path.join(dir, 'consumption.db')
  const decisionPath = path.join(dir, 'decision.json')
  writeFileSync(decisionPath, JSON.stringify(sampleDecision()))
  const run = (id: string) =>
    spawnSync('npx', ['tsx', 'src/consumption/cli.ts', dbPath, decisionPath, id], {
      encoding: 'utf8',
      cwd: path.resolve(import.meta.dirname, '../..'),
    })
  new ConsumptionStore(dbPath).close()
  const a = run('inv-cli-a')
  const b = run('inv-cli-b')
  const outcomes = [a, b].map((proc) => JSON.parse(proc.stdout) as { status: string })
  const winners = outcomes.filter(o => o.status === 'claimed' || o.status === 'replayed')
  const losers = outcomes.filter(o => o.status === 'rejected')
  assert.equal(winners.length, 1, `expected exactly one winner, got ${JSON.stringify(outcomes)}`)
  assert.equal(losers.length, 1)
  rmSync(dir, { recursive: true, force: true })
})


test('changed approved content cannot replay an old receipt with a matching submitted digest', () => {
  const store = new ConsumptionStore(':memory:')
  const original = sampleDecision()
  const first = store.claim(original, 'inv-b')
  for (const change of [
    { permittedAction: 'different action' }, { decisionRequestId: 'different request' },
    { chosenOption: 'defer' }, { rationale: 'changed' }, { decidedAt: '2026-09-04T00:00:00Z' },
    { expiresAt: '2100-01-01T00:00:00Z' },
  ]) {
    const changed = { ...original, ...change }
    const result = store.claim(changed, 'inv-b', decisionDigest(changed))
    assert.equal(result.status, 'rejected')
    if (result.status === 'rejected') assert.equal(result.reason, 'digest_mismatch')
    assert.deepEqual(store.getReceipt(original.decisionId), first.status === 'claimed' ? first.receipt : undefined)
  }
  store.close()
})

test('expiry extension or removal cannot use the old digest', () => {
  const store = new ConsumptionStore(':memory:')
  const expired = sampleDecision({ expiresAt: '2000-01-01T00:00:00Z' })
  const digest = decisionDigest(expired)
  assert.equal(store.claim(expired, 'inv-b', digest).status, 'rejected')
  for (const expiresAt of ['2100-01-01T00:00:00Z', undefined]) {
    const result = store.claim({ ...expired, expiresAt }, 'inv-b', digest)
    assert.equal(result.status, 'rejected')
    if (result.status === 'rejected') assert.equal(result.reason, 'digest_mismatch')
  }
  assert.equal(store.getReceipt(expired.decisionId), undefined)
  store.close()
})

test('invalid expiry rejects malformed dates and calendar rollovers without a claim', () => {
  const store = new ConsumptionStore(':memory:')
  for (const expiresAt of ['invalid-date', '', '2100-01-01', '2100-02-29T00:00:00Z',
    '2100-04-31T00:00:00Z', '2100-01-01T24:00:00Z', '2100-01-01T00:00:00+24:00']) {
    const result = store.claim(sampleDecision({ expiresAt }), 'inv-b')
    assert.equal(result.status, 'rejected', expiresAt)
    if (result.status === 'rejected') assert.equal(result.reason, 'invalid_expiry')
    assert.equal(store.getReceipt('dec-001'), undefined)
  }
  assert.equal(store.claim(sampleDecision({ expiresAt: '2104-02-29T12:00:00.123+01:00' }), 'inv-b').status, 'claimed')
  store.close()
})

test('legacy receipts stay byte-for-byte intact but cannot authorize replay, with or without supplied expiry', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wd-legacy-'))
  const dbPath = path.join(dir, 'claims.db')
  new ConsumptionStore(dbPath).close()
  const db = new Database(dbPath)
  const decision = sampleDecision()
  // Exact pre-repair six-field digest, shared by old expiry/no-expiry inputs.
  const oldDigest = `sha256:${createHash('sha256').update(JSON.stringify(decision)).digest('hex')}`
  const receipt = { schema: 'who-decides.consumption-receipt.v0', receiptId: 'legacy',
    decisionId: decision.decisionId, decisionDigest: oldDigest, decisionRequestId: decision.decisionRequestId,
    permittedAction: decision.permittedAction, successorInvocationId: 'inv-b', claimedAt: decision.decidedAt,
    claimNote: 'historical fixture' }
  const bytes = JSON.stringify(receipt)
  db.prepare('INSERT INTO consumption_receipts VALUES (?, ?, ?, ?, ?)').run(decision.decisionId, bytes, 'inv-b', oldDigest, decision.decidedAt)
  const store = new ConsumptionStore(dbPath)
  for (const expiresAt of [undefined, '2100-01-01T00:00:00Z']) {
    assert.equal(store.claim({ ...decision, expiresAt }, 'inv-b').status, 'rejected')
    assert.deepEqual(store.getReceipt(decision.decisionId), receipt)
  }
  assert.equal((db.prepare('SELECT receipt_json FROM consumption_receipts').get() as { receipt_json: string }).receipt_json, bytes)
  store.close()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})
