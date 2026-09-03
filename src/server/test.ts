/* Console engine tests: branch execution, runtime-built decision artifacts,
 * idempotent recovery, crash-safe successor reuse, archived reset, and the
 * one-active-run invariant. Run: npm run test:console */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { ConsoleEngine } from './state'

function freshEngine(): { engine: ConsoleEngine, dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'wd-console-test-'))
  process.env.WD_CONSOLE_DIR = dir
  return { engine: new ConsoleEngine(), dir }
}

function cleanup(dir: string, engine: ConsoleEngine): void {
  delete process.env.WD_CONSOLE_DIR
  engine.close()
  rmSync(dir, { recursive: true, force: true })
}

/** Fast-forward the wall-clock phases by aging the current phase marker. */
function agePhase(dir: string, seconds: number): void {
  const db = new Database(path.join(dir, 'state.db'))
  db.prepare('UPDATE runs SET phase_changed_at = ?').run(new Date(Date.now() - seconds * 1000).toISOString())
  db.close()
}

function runToDecision(engine: ConsoleEngine, dir: string): void {
  engine.startRun()
  agePhase(dir, 10)
}

function readArtifact(dir: string, name: string): Record<string, unknown> {
  const db = new Database(path.join(dir, 'state.db'))
  const row = db.prepare('SELECT json FROM artifacts WHERE name = ?').get(name) as { json: string }
  db.close()
  return JSON.parse(row.json) as Record<string, unknown>
}

test('each choice executes only its own branch (send_back/defer never build a PR)', () => {
  const branchMarker: Record<string, string> = {
    create_draft_pr: 'draft-PR receipt',
    send_back: 'created no PR',
    defer: 'executed nothing',
  }
  for (const [choice, marker] of Object.entries(branchMarker)) {
    const { engine, dir } = freshEngine()
    try {
      runToDecision(engine, dir)
      const result = engine.submitDecision(choice, `rationale for ${choice}`, 'test-key')
      assert.equal(result.ok, true, `${choice} should submit cleanly`)
      agePhase(dir, 10)
      const state = engine.getState()
      assert.equal(state.state, 'completed')
      const payload = (state.effect?.exactPayload ?? {}) as Record<string, unknown>
      if (choice === 'create_draft_pr') {
        assert.ok('repo' in payload && 'branch' in payload, 'approval builds the draft-PR payload')
      } else {
        assert.ok(!('repo' in payload) && !('branch' in payload), `${choice} must not build a PR payload`)
        assert.ok('outcome' in payload, `${choice} records its own no-PR outcome`)
      }
      const report = readArtifact(dir, 'agent-report')
      assert.ok(String(report.behaviour_implemented).includes(marker), `${choice} report names its branch`)
      assert.equal(report.requested_next_step, choice === 'create_draft_pr' ? 'complete' : choice === 'send_back' ? 'revise_and_resubmit' : 'revisit_on_request', `${choice} sets its own next step`)
      assert.ok(state.artifacts.every(a => a.valid), `${choice}: all artifacts valid`)
    } finally {
      cleanup(dir, engine)
    }
  }
})

test('human-decision artifact records the submitted choice, rationale, and dynamic id', () => {
  const { engine, dir } = freshEngine()
  try {
    runToDecision(engine, dir)
    engine.submitDecision('send_back', 'my actual rationale text', 'test-key')
    const decision = readArtifact(dir, 'human-decision')
    assert.equal(decision.reason, 'my actual rationale text')
    assert.equal(decision.decision, 'request_review')
    assert.equal(decision.to_status, 'draft')
    assert.match(String(decision.decision_id), /^decision-run-/)
    const receipt = readArtifact(dir, 'consumption-receipt')
    assert.equal(receipt.decisionId, decision.decision_id, 'artifact and receipt share decision identity')
  } finally {
    cleanup(dir, engine)
  }
})

test('retrying a committed decision returns idempotent success, not WRONG_STATE', () => {
  const { engine, dir } = freshEngine()
  try {
    runToDecision(engine, dir)
    const first = engine.submitDecision('create_draft_pr', 'approved', 'key-1')
    assert.equal(first.ok, true)
    const retry = engine.submitDecision('create_draft_pr', 'approved', 'key-1')
    assert.equal(retry.ok, true)
    assert.equal(retry.duplicate, true)
    // A DIFFERENT decision after one was recorded is a conflict, not a
    // duplicate success — the first decision was consumed.
    const conflict = engine.submitDecision('defer', 'changed my mind', 'key-2')
    assert.equal(conflict.ok, false)
    assert.equal(conflict.error, 'DECISION_ALREADY_RECORDED')
  } finally {
    cleanup(dir, engine)
  }
})

test('the decision artifact cites a real evidence digest, not a placeholder', () => {
  const { engine, dir } = freshEngine()
  try {
    runToDecision(engine, dir)
    engine.submitDecision('create_draft_pr', 'approved', 'key-1')
    const decision = readArtifact(dir, 'human-decision')
    const refs = decision.evidence_refs as string[]
    const digestRef = refs.find(r => String(r).startsWith('sha256:'))
    assert.ok(digestRef, 'evidence_refs carries a sha256 reference')
    assert.match(String(digestRef), /^sha256:[0-9a-f]{64}$/, 'the digest is a real 64-hex hash of the stop-response evidence')
  } finally {
    cleanup(dir, engine)
  }
})

test('crash between claim and state-write recovers with the same successor (no competing claim)', () => {
  const { engine, dir } = freshEngine()
  try {
    runToDecision(engine, dir)
    engine.submitDecision('create_draft_pr', 'approved', 'key-1')
    const successor = engine.getState().invocationB
    // Simulate the crash window: the claim committed, the run row did not.
    const db = new Database(path.join(dir, 'state.db'))
    db.prepare("UPDATE runs SET state = 'decision_required', receipt_json = NULL, effect_json = NULL").run()
    db.close()
    const recovery = engine.submitDecision('create_draft_pr', 'approved', 'key-1')
    assert.equal(recovery.ok, true, 'retry must recover, not strand the run')
    const receipt = readArtifact(dir, 'consumption-receipt')
    assert.equal(receipt.successorInvocationId, successor, 'recovery reuses the persisted successor — never a competing claim')
    agePhase(dir, 10)
    assert.equal(engine.getState().state, 'completed')
  } finally {
    cleanup(dir, engine)
  }
})

test('reset archives completed runs instead of deleting audit records', () => {
  const { engine, dir } = freshEngine()
  try {
    runToDecision(engine, dir)
    engine.submitDecision('defer', 'not now', 'key-1')
    agePhase(dir, 10)
    assert.equal(engine.getState().state, 'completed')
    engine.reset()
    assert.equal(engine.getState().state, 'ready', 'console is ready for a fresh run')
    const db = new Database(path.join(dir, 'state.db'))
    const rows = db.prepare('SELECT COUNT(*) AS n FROM runs WHERE archived = 1').get() as { n: number }
    const artifacts = db.prepare('SELECT COUNT(*) AS n FROM artifacts').get() as { n: number }
    db.close()
    assert.equal(rows.n, 1, 'completed run row survives reset')
    assert.ok(artifacts.n >= 8, 'completed run artifacts survive reset')
  } finally {
    cleanup(dir, engine)
  }
})

test('a second start while a run is active returns the same run', () => {
  const { engine, dir } = freshEngine()
  try {
    const first = engine.startRun()
    const second = engine.startRun()
    assert.equal(second.runId, first.runId)
  } finally {
    cleanup(dir, engine)
  }
})
