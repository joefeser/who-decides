/* Artifact pipeline tests: upstream canonical examples validate; our
 * scenario artifacts validate; tampered artifacts FAIL. Run: npm run test:artifacts */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateArtifact } from './schemas'
import type { ArtifactKind } from './schemas'
import { buildTaskPacket, buildReviewFindings, buildStopResponse, buildHumanDecision, buildAgentReport } from './build'
import type { Scenario } from './build'

const EXAMPLES: Array<[ArtifactKind, string]> = [
  ['task-packet', 'task-packet.valid.json'],
  ['human-decision', 'human-decision.valid.json'],
  ['agent-report', 'agent-report.valid.json'],
  ['review-finding', 'review-finding.valid.json'],
  ['stop-response', 'stop-response.valid.json'],
]

const runtimeDecision = (choice: string) => ({
  decisionId: scenario.decision_id,
  choice,
  rationale: scenario.human_choice.rationale,
  decidedAt: '2026-09-03T00:00:00.000Z',
})

const scenario = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, '../../fixtures/patch-scenario.json'), 'utf8'),
) as Scenario

test('upstream canonical examples validate against vendored schemas', () => {
  for (const [kind, file] of EXAMPLES) {
    const example = JSON.parse(
      readFileSync(path.resolve(import.meta.dirname, '../../.tmp/hacp-examples', file), 'utf8'),
    )
    const result = validateArtifact(kind, example)
    assert.ok(result.valid, `${file} should validate (${result.valid ? '' : ('errors: ' + (result as { errors?: string[] }).errors?.join('; '))})`)
  }
})

test('scenario artifacts validate: packet, findings, stop, decision, report', () => {
  assert.ok(validateArtifact('task-packet', buildTaskPacket(scenario)).valid)
  for (const finding of buildReviewFindings(scenario)) {
    assert.ok(validateArtifact('review-finding', finding).valid)
  }
  assert.ok(validateArtifact('stop-response', buildStopResponse(scenario)).valid)
  const runtime = { decisionId: scenario.decision_id, choice: scenario.human_choice.decision, rationale: scenario.human_choice.rationale, decidedAt: '2026-09-03T00:00:00.000Z' }
  assert.ok(validateArtifact('human-decision', buildHumanDecision(scenario, runtime, 'test-digest')).valid)
  assert.ok(validateArtifact('agent-report', buildAgentReport(scenario, runtime, 'receipt-1', 'cafebabe')).valid)
})

test('non-approval choices map to protocol-legal decisions, not start_work', () => {
  const mk = (choice: string) => buildHumanDecision(scenario, {
    decisionId: scenario.decision_id, choice, rationale: 'branch test', decidedAt: '2026-09-03T00:00:00.000Z',
  }, 'd')
  const sendBack = mk('send_back') as Record<string, unknown>
  assert.equal(sendBack.decision, 'request_review')
  assert.equal(sendBack.to_status, 'draft')
  const defer = mk('defer') as Record<string, unknown>
  assert.equal(defer.decision, 'cancel_session')
  assert.equal(defer.to_status, 'canceled')
  assert.ok(validateArtifact('human-decision', sendBack).valid)
  assert.ok(validateArtifact('human-decision', defer).valid)
})

test('tampered task packet (authority escalated) FAILS', () => {
  const packet = buildTaskPacket(scenario) as Record<string, unknown>
  packet.authority = 'accepts_all_risk' // not in the vocabulary
  assert.equal(validateArtifact('task-packet', packet).valid, false)
})

test('tampered decision (actor demoted to agent) FAILS', () => {
  const decision = buildHumanDecision(scenario, runtimeDecision('create_draft_pr'), 'd') as Record<string, unknown>
  decision.actor_kind = 'ai_agent' // only human verifications allowed
  assert.equal(validateArtifact('human-decision', decision).valid, false)
})

test('decision missing required rationale FAILS', () => {
  const decision = buildHumanDecision(scenario, runtimeDecision('create_draft_pr'), 'd') as Record<string, unknown>
  delete decision.reason
  assert.equal(validateArtifact('human-decision', decision).valid, false)
})

test('stop-response with reliability_boundary on a non-reliability stop FAILS', () => {
  const stop = buildStopResponse(scenario) as Record<string, unknown>
  stop.reliability_boundary = { anything: true } // only valid for RELIABILITY_LIMIT_REACHED
  assert.equal(validateArtifact('stop-response', stop).valid, false)
})

test('report claiming boundaries preserved while crossing them FAILS', () => {
  const report = buildAgentReport(scenario, runtimeDecision('create_draft_pr'), 'r', 'd') as Record<string, unknown>
  report.boundary_crossed_reason = 'merged_without_decision'
  report.boundaries_preserved = true
  assert.equal(validateArtifact('agent-report', report).valid, false)
})
