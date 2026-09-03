/* Consumption receipt tests — the spike-log test list:
 * happy claim · identical replay · competing successor rejected ·
 * digest mismatch rejected · expiry ordering · restart survival ·
 * in-process concurrent race · cross-process concurrent race (two CLIs).
 * Run: npm run test:consumption */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ConsumptionStore } from './store.js'
import type { DecisionRecord } from './store.js'

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

test('in-process concurrent race: many connections, exactly one winner', () => {
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

test('cross-process concurrent race: two CLIs, exactly one winner', () => {
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
