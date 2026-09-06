/* Consumption receipt tests on Postgres — a semantic port of the frozen
 * ConsumptionStore's suite (src/consumption/test.ts) plus the local
 * contention proof (scripts/consumption-proof.mjs) condensed to its
 * load-bearing assertions: claims serialize on the decision's write slot,
 * expiry is re-sampled INSIDE the slot, and a loser with the identical
 * binding replays instead of re-claiming. Run: npm run test:consumption-pg
 * (green skip without WD_TEST_PG_URL). */
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decisionDigest, CONSUMPTION_SCHEMA } from './store'
import type { DecisionRecord } from './store'
import { PostgresReceiptStore } from '../server/store/pg-receipt-store'
import { WD_TEST_PG_URL, skipWhenNoPostgres, pgConfig, pgQuery } from '../pg-test-env'

let unique = 0
// Unlike the sqlite suite's throwaway :memory: files, the Postgres test
// database persists across runs — every run claims brand-new decision ids.
const runPrefix = randomUUID()
function sampleDecision(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  unique += 1
  return {
    decisionId: `dec-pg-${runPrefix}-${unique}`,
    chosenOption: 'create_draft_pr',
    rationale: 'human approved after reviewing tradeoff',
    decidedAt: '2026-09-03T22:00:00.000Z',
    decisionRequestId: 'req-001',
    permittedAction: 'create draft PR (dry-run receipt)',
    ...overrides,
  }
}

function freshStore(): PostgresReceiptStore {
  return new PostgresReceiptStore(pgConfig())
}

if (skipWhenNoPostgres('consumption-pg suite')) {
  test('happy path: claim once, receipt is immutable and honest', async () => {
    const store = freshStore()
    const decision = sampleDecision()
    const result = await store.claim(decision, 'inv-b')
    assert.equal(result.status, 'claimed')
    if (result.status === 'claimed') {
      assert.match(result.receipt.decisionDigest, /^sha256:[0-9a-f]{64}$/)
      assert.equal(result.receipt.successorInvocationId, 'inv-b')
      assert.equal(result.receipt.schema, CONSUMPTION_SCHEMA)
      assert.match(result.receipt.claimNote, /does not prove/)
    }
    await store.close()
  })

  test('identical replay by the same successor returns the existing claim (recovery)', async () => {
    const store = freshStore()
    const decision = sampleDecision()
    const first = await store.claim(decision, 'inv-b')
    const retry = await store.claim(decision, 'inv-b')
    assert.equal(first.status, 'claimed')
    assert.equal(retry.status, 'replayed')
    if (first.status === 'claimed' && retry.status === 'replayed') {
      assert.equal(retry.receipt.receiptId, first.receipt.receiptId)
    }
    await store.close()
  })

  test('competing successor is rejected — one decision, one invocation', async () => {
    const store = freshStore()
    const decision = sampleDecision()
    await store.claim(decision, 'inv-b')
    const competitor = await store.claim(decision, 'inv-c')
    assert.equal(competitor.status, 'rejected')
    if (competitor.status === 'rejected') assert.equal(competitor.reason, 'competing_successor')
    await store.close()
  })

  test('digest mismatch is rejected (integrity basis enforced)', async () => {
    const store = freshStore()
    const result = await store.claim(sampleDecision(), 'inv-b', 'sha256:deadbeef')
    assert.equal(result.status, 'rejected')
    if (result.status === 'rejected') assert.equal(result.reason, 'digest_mismatch')
    await store.close()
  })

  test('expired decision is rejected before any claim is written', async () => {
    const store = freshStore()
    const decision = sampleDecision({ expiresAt: new Date(Date.now() - 1000).toISOString() })
    const result = await store.claim(decision, 'inv-b')
    assert.equal(result.status, 'rejected')
    if (result.status === 'rejected') assert.equal(result.reason, 'expired')
    assert.equal(await store.getReceipt(decision.decisionId), undefined)
    await store.close()
  })

  test('expiry order: a claim that later expires cannot be replayed by an identical retry', async () => {
    // Frozen ordering: expiry is judged BEFORE the replay read, so a lapsed
    // approval can never be resurrected via the replay path (review finding).
    const store = freshStore()
    const decision = sampleDecision({ expiresAt: new Date(Date.now() + 350).toISOString() })
    const first = await store.claim(decision, 'inv-b')
    assert.equal(first.status, 'claimed')
    await new Promise(r => setTimeout(r, 400))
    const retry = await store.claim(decision, 'inv-b')
    assert.equal(retry.status, 'rejected')
    if (retry.status === 'rejected') assert.equal(retry.reason, 'expired')
    // History is preserved byte-for-byte; rejection does not mutate it.
    if (first.status === 'claimed') assert.deepEqual(await store.getReceipt(decision.decisionId), first.receipt)
    await store.close()
  })

  test('getReceipt on a fresh empty store returns undefined, not a missing-relation error', async () => {
    const store = freshStore()
    assert.equal(await store.getReceipt('no-such-decision'), undefined)
    await store.close()
  })

  test('restart survival: a fresh store on the same database preserves the claim', async () => {
    const store = freshStore()
    const decision = sampleDecision()
    await store.claim(decision, 'inv-b')
    await store.close()
    const reopened = freshStore()
    const receipt = await reopened.getReceipt(decision.decisionId)
    assert.ok(receipt)
    assert.equal(receipt?.successorInvocationId, 'inv-b')
    const competitor = await reopened.claim(decision, 'inv-z')
    assert.equal(competitor.status, 'rejected')
    await reopened.close()
  })

  test('sequential store instances: exactly one winner', async () => {
    const decision = sampleDecision()
    const successors = Array.from({ length: 12 }, (_, i) => `inv-${i}`)
    let claimed = 0
    let rejected = 0
    for (const id of successors) {
      const store = freshStore()
      try {
        const result = await store.claim(decision, id)
        if (result.status === 'claimed') claimed += 1
        if (result.status === 'rejected' && result.reason === 'competing_successor') rejected += 1
      } finally {
        await store.close()
      }
    }
    assert.equal(claimed, 1)
    assert.equal(rejected, successors.length - 1)
  })

  test('changed approved content cannot replay an old receipt with a matching submitted digest', async () => {
    const store = freshStore()
    const original = sampleDecision()
    const first = await store.claim(original, 'inv-b')
    for (const change of [
      { permittedAction: 'different action' }, { decisionRequestId: 'different request' },
      { chosenOption: 'defer' }, { rationale: 'changed' }, { decidedAt: '2026-09-04T00:00:00Z' },
      { expiresAt: '2100-01-01T00:00:00Z' },
    ]) {
      const changed = { ...original, ...change }
      const result = await store.claim(changed, 'inv-b', decisionDigest(changed))
      assert.equal(result.status, 'rejected')
      if (result.status === 'rejected') assert.equal(result.reason, 'digest_mismatch')
      assert.deepEqual(await store.getReceipt(original.decisionId), first.status === 'claimed' ? first.receipt : undefined)
    }
    await store.close()
  })

  test('expiry extension or removal cannot use the old digest', async () => {
    const store = freshStore()
    const expired = sampleDecision({ expiresAt: '2000-01-01T00:00:00Z' })
    const digest = decisionDigest(expired)
    assert.equal((await store.claim(expired, 'inv-b', digest)).status, 'rejected')
    for (const expiresAt of ['2100-01-01T00:00:00Z', undefined]) {
      const result = await store.claim({ ...expired, expiresAt }, 'inv-b', digest)
      assert.equal(result.status, 'rejected')
      if (result.status === 'rejected') assert.equal(result.reason, 'digest_mismatch')
    }
    assert.equal(await store.getReceipt(expired.decisionId), undefined)
    await store.close()
  })

  test('invalid expiry rejects malformed dates and calendar rollovers without a claim', async () => {
    const store = freshStore()
    for (const expiresAt of ['invalid-date', '', '2100-01-01', '2100-02-29T00:00:00Z',
      '2100-04-31T00:00:00Z', '2100-01-01T24:00:00Z', '2100-01-01T00:00:00+24:00']) {
      const decision = sampleDecision({ expiresAt })
      const result = await store.claim(decision, 'inv-b')
      assert.equal(result.status, 'rejected', expiresAt)
      if (result.status === 'rejected') assert.equal(result.reason, 'invalid_expiry')
      assert.equal(await store.getReceipt(decision.decisionId), undefined)
    }
    assert.equal((await store.claim(sampleDecision({ expiresAt: '2104-02-29T12:00:00.123+01:00' }), 'inv-b')).status, 'claimed')
    await store.close()
  })

  test('legacy receipts stay byte-for-byte intact but cannot authorize replay', async () => {
    const store = freshStore()
    const { createHash } = await import('node:crypto')
    const decision = sampleDecision()
    // Exact pre-repair six-field digest, shared by old expiry/no-expiry inputs.
    const oldDigest = `sha256:${createHash('sha256').update(JSON.stringify(decision)).digest('hex')}`
    const receipt = { schema: 'who-decides.consumption-receipt.v0', receiptId: 'legacy',
      decisionId: decision.decisionId, decisionDigest: oldDigest, decisionRequestId: decision.decisionRequestId,
      permittedAction: decision.permittedAction, successorInvocationId: 'inv-b', claimedAt: decision.decidedAt,
      claimNote: 'historical fixture' }
    const bytes = JSON.stringify(receipt)
    // Warm the schema with a throwaway decision — the legacy fixture id
    // itself must still be free for the raw INSERT below.
    await store.claim(sampleDecision(), 'inv-warmup-schema')
    await pgQuery(
      'INSERT INTO consumption_receipts (decision_id, receipt_json, successor_invocation_id, decision_digest, claimed_at) VALUES ($1, $2, $3, $4, $5)',
      [decision.decisionId, bytes, 'inv-b', oldDigest, decision.decidedAt],
    )
    for (const expiresAt of [undefined, '2100-01-01T00:00:00Z']) {
      assert.equal((await store.claim({ ...decision, expiresAt }, 'inv-b')).status, 'rejected')
      assert.deepEqual(await store.getReceipt(decision.decisionId), receipt)
    }
    const row = await pgQuery('SELECT receipt_json FROM consumption_receipts WHERE decision_id = $1', [decision.decisionId])
    assert.equal(row.rows[0].receipt_json, bytes)
    await store.close()
  })

  // ---- contention-proof ports (scripts/consumption-proof.mjs) ----

  test('contention: expiry is re-sampled INSIDE the write slot, not at call time', async () => {
    const store = freshStore()
    const decision = sampleDecision({ expiresAt: new Date(Date.now() + 400).toISOString() })
    // Hold the same advisory lock the claim path acquires: the claimant must
    // block inside its write boundary, and by the time we release, the
    // decision has expired — an at-call-time check would have claimed.
    const { Pool } = await import('pg')
    const holder = new Pool({ connectionString: WD_TEST_PG_URL })
    const client = await holder.connect()
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(7002, hashtext($1))', [decision.decisionId])
    try {
      const releasedAt = Date.now() + 900
      const claimPromise = store.claim(decision, 'inv-b')
      await new Promise(r => setTimeout(r, 100)) // claimant is now blocked in the slot
      await new Promise(r => setTimeout(r, releasedAt - Date.now()))
      await client.query('COMMIT')
      const result = await claimPromise
      assert.equal(result.status, 'rejected')
      if (result.status === 'rejected') {
        assert.equal(result.reason, 'expired')
        assert.match(result.detail, /rechecked after write-slot wait/)
      }
      assert.equal(await store.getReceipt(decision.decisionId), undefined)
    } finally {
      if (client) { try { await client.query('ROLLBACK') } catch { /* ended */ } client.release() }
      await holder.end()
    }
    await store.close()
  })

  test('contention: one winner under a held slot; identical loser replays', async () => {
    const decision = sampleDecision()
    const { Pool } = await import('pg')
    const holder = new Pool({ connectionString: WD_TEST_PG_URL })
    const client = await holder.connect()
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(7002, hashtext($1))', [decision.decisionId])
    const winnerStore = freshStore()
    const loserStore = freshStore()
    try {
      const holdUntil = Date.now() + 500
      const firstPromise = winnerStore.claim(decision, 'inv-a')
      const secondPromise = loserStore.claim(decision, 'inv-a') // identical binding
      await new Promise(r => setTimeout(r, 100)) // both claimants now blocked in the slot
      await new Promise(r => setTimeout(r, Math.max(0, holdUntil - Date.now())))
      await client.query('COMMIT') // release the slot
      // Either claimant may acquire the slot first — the contract is that
      // exactly one claims and the identical one replays.
      const [first, second] = await Promise.all([firstPromise, secondPromise])
      const winner = first.status === 'claimed' ? first : second
      const loser = first.status === 'claimed' ? second : first
      assert.equal(winner.status, 'claimed')
      assert.equal(loser.status, 'replayed')
      if (winner.status === 'claimed' && loser.status === 'replayed') {
        assert.equal(loser.receipt.receiptId, winner.receipt.receiptId)
        // claimedAt was stamped AFTER the slot wait (time re-sampled in the
        // boundary), not at call time.
        assert.ok(Date.parse(winner.receipt.claimedAt) >= holdUntil - 50)
      }
      // The persisted row is byte-identical to the winner's receipt…
      const row = await pgQuery('SELECT receipt_json FROM consumption_receipts WHERE decision_id = $1', [decision.decisionId])
      assert.equal(row.rows.length, 1)
      // …and a fresh instance returns exactly the winner (restart replay).
      const recovery = freshStore()
      const replay = await recovery.claim(decision, 'inv-a')
      assert.equal(replay.status, 'replayed')
      if (winner.status === 'claimed' && replay.status === 'replayed') {
        assert.deepEqual(replay.receipt, winner.receipt)
      }
      await recovery.close()
    } finally {
      try { await client.query('ROLLBACK') } catch { /* ended */ }
      client.release()
      await holder.end()
      await winnerStore.close()
      await loserStore.close()
    }
  })

  test('contention: N concurrent competing claims yield exactly one winner', async () => {
    const decision = sampleDecision()
    const contenders = Array.from({ length: 8 }, (_, i) => freshStore())
    try {
      const results = await Promise.all(contenders.map((store, i) => store.claim(decision, `inv-${i}`)))
      const claimed = results.filter(r => r.status === 'claimed')
      const competing = results.filter(r => r.status === 'rejected' && r.reason === 'competing_successor')
      assert.equal(claimed.length, 1)
      assert.equal(competing.length, contenders.length - 1)
      const row = await pgQuery('SELECT receipt_json FROM consumption_receipts WHERE decision_id = $1', [decision.decisionId])
      assert.equal(row.rows.length, 1)
    } finally {
      await Promise.all(contenders.map(s => s.close()))
    }
  })
}
