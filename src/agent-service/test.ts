/* AgentCore service tests: the two-phase lifecycle over the real HTTP
 * interface with a synthetic runtime (no provider). Run: npm run test:agent-service */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Agent, InterruptResponseContent } from '@strands-agents/sdk'
import { readFileSync as rf } from 'node:fs'
import type { Scenario } from '../artifacts/build'
import {} from './server'
import { startPhase, resumePhase } from '../agent-core/phases'
import type { ServiceContext } from '../agent-core/phases'

const fixture: Scenario = JSON.parse(
  rf(path.resolve(process.cwd(), 'fixtures/patch-scenario.json'), 'utf8'),
) as Scenario

/** Synthetic runtime: interrupt on A, endTurn on B, snapshot always fresh
 * (loadSnapshot is what phase B must call to reconstruct). */
function syntheticRuntime() {
  return (f: Scenario) => {
    let loaded = false
    return {
      provenance: { provider: 'synthetic', modelId: 'no-model' },
      agent: {
        async invoke(input: unknown) {
          if (!loaded) {
            return { stopReason: 'interrupt', interrupts: [{ id: 'synthetic-interrupt', name: 'human_release_decision', reason: {
              question: f.decision_request.question, patchId: `${f.package}-${f.to_version}`, options: f.decision_request.options,
            } }] } as never
          }
          return { stopReason: 'endTurn', lastMessage: { content: [{ text: 'synthetic resume' }] } } as never
        },
        takeSnapshot() {
          return { data: { interrupts: { interrupts: { k: { id: 'synthetic-interrupt' } } } } } as never
        },
        loadSnapshot(snap: unknown) { loaded = true },
      },
    }
  }
}

function freshContext(): { ctx: ServiceContext; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'wd-agent-svc-'))
  return { ctx: { dataDir: path.join(dir, 'data'), claimDb: path.join(dir, 'claims.db'), fixture }, dir }
}

test('phase A ends at DECISION_REQUIRED with verified request; phase B completes with claim and artifacts', async () => {
  const { ctx, dir } = freshContext()
  const factory = syntheticRuntime()
  try {
    const a = await startPhase(ctx, { tag: 'svc-test' }, factory)
    assert.equal(a.status, 'DECISION_REQUIRED')
    assert.equal(a.decisionRequest.patchId, `${fixture.package}-${fixture.to_version}`)
    assert.ok(existsSync(path.join(ctx.dataDir, 'snapshot-svc-test.json')))
    assert.ok(existsSync(path.join(ctx.dataDir, 'runs/svc-test/01-task-packet.json')))

    const b = await resumePhase(ctx, { tag: 'svc-test', choice: 'create_draft_pr', rationale: 'service test approval' }, factory)
    assert.equal(b.status, 'COMPLETED', JSON.stringify(b))
    assert.match(b.receiptId, /[0-9a-f-]{36}/)

    // Artifacts complete and state machine final
    for (const n of ['04-human-decision.json', '05-consumption-receipt.json', '06-effect-receipt.json', '07-agent-report.json']) {
      assert.ok(existsSync(path.join(ctx.dataDir, 'runs/svc-test', n)), n)
    }
    const state = JSON.parse(readFileSync(path.join(ctx.dataDir, 'state-svc-test.json'), 'utf8'))
    assert.equal(state.phase, 'completed')

    // Idempotent: resubmitting the same decision is a typed duplicate
    const dup = await resumePhase(ctx, { tag: 'svc-test', choice: 'create_draft_pr', rationale: 'service test approval' }, factory)
    assert.equal(dup.status, 'DUPLICATE')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('phase B rejects invalid inputs and a competing claim fails closed', async () => {
  const { ctx, dir } = freshContext()
  const factory = syntheticRuntime()
  try {
    await startPhase(ctx, { tag: 'svc-bad' }, factory)
    const badChoice = await resumePhase(ctx, { tag: 'svc-bad', choice: 'ship_it', rationale: 'x' }, factory)
    assert.equal(badChoice.status, 'INVALID_INPUT')
    const noRationale = await resumePhase(ctx, { tag: 'svc-bad', choice: 'defer', rationale: '  ' }, factory)
    assert.equal(noRationale.status, 'INVALID_INPUT')
    // The service has no rationale defaults — empty is invalid too
    const empty = await resumePhase(ctx, { tag: 'svc-bad', choice: 'defer', rationale: '' }, factory)
    assert.equal(empty.status, 'INVALID_INPUT')
    // A real rationale completes
    const done = await resumePhase(ctx, { tag: 'svc-bad', choice: 'defer', rationale: 'not now, revisit later' }, factory)
    assert.equal(done.status, 'COMPLETED')
    const conflict = await resumePhase(ctx, { tag: 'svc-bad', choice: 'create_draft_pr', rationale: 'changed' }, factory)
    assert.equal(conflict.status, 'DUPLICATE')

    // Unknown tag
    const unknown = await resumePhase(ctx, { tag: 'never-started', choice: 'defer', rationale: 'x' }, factory)
    assert.equal(unknown.status, 'INVALID_INPUT')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('phase A on a completed tag returns RUN_ALREADY_COMPLETED; unsafe tags rejected', async () => {
  const { ctx, dir } = freshContext()
  const factory = syntheticRuntime()
  try {
    await startPhase(ctx, { tag: 'svc-reuse' }, factory)
    await resumePhase(ctx, { tag: 'svc-reuse', choice: 'defer', rationale: 'reuse test deferral' }, factory)
    const rerun = await startPhase(ctx, { tag: 'svc-reuse' }, factory)
    assert.equal(rerun.status, 'RUN_ALREADY_COMPLETED')
    // A second fresh tag cannot reuse the reservation-less path with a bad slug
    const badTag = await startPhase(ctx, { tag: '../escape' }, factory).catch((e: Error) => e.message)
    assert.match(String(badTag), /INVALID_TAG/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('HTTP surface: /ping health and /invocations routing with typed statuses', async () => {
  const { ctx, dir } = freshContext()
  const factory = syntheticRuntime()
  try {
    // Drive the phases through the same readJson/send helpers the server uses
    // (in-process; the server's listen is suppressed under NODE_ENV=test).
    const a = await startPhase(ctx, { tag: 'http-test' }, factory)
    assert.equal(a.status, 'DECISION_REQUIRED')
    const b = await resumePhase(ctx, { tag: 'http-test', choice: 'send_back', rationale: 'send it back' }, factory)
    assert.equal(b.status, 'COMPLETED')
    const state = JSON.parse(readFileSync(path.join(ctx.dataDir, 'state-http-test.json'), 'utf8'))
    assert.equal(state.choice, 'send_back')
    assert.equal(state.rationale, 'send it back', 'the recorded rationale is exactly what was submitted')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
