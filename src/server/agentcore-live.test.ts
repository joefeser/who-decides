/* Strict gated live test for the DEPLOYED AgentCore runtime (AC-6).
 *
 * NOT part of `npm test` or CI. Run explicitly on a host configured for
 * live dispatch:
 *
 *   WD_AGENTCORE_ENDPOINT=<runtime ARN> WD_MACHINE_TOKEN=<service token> \
 *     npm run test:agentcore-live
 *
 * It spends real AWS + model invocations on the real runtime. Gate
 * semantics (a skip is not a pass, and neither is any typed error):
 *
 * - WD_AGENTCORE_ENDPOINT absent → every test SKIPs with the reason.
 *   A skip records "not verified", never AC-6 completion.
 * - Endpoint set but WD_MACHINE_TOKEN missing, dispatcher init failure,
 *   missing SDK, AWS credential/permission errors, transport failures,
 *   and malformed response envelopes all FAIL the gate.
 * - The only passing path is a real A → human decision → B cycle through
 *   the PRODUCTION dispatcher wiring (`getAgentDispatcher`, the same
 *   client `app/api/*` uses), asserting the 'aws-sdk' transport on every
 *   dispatch so the deterministic/disabled fallback can never satisfy
 *   the gate.
 * - Phase A must return exactly DECISION_REQUIRED with the scenario's
 *   decision request; the approved resume must return exactly COMPLETED
 *   with the run/decision binding and receipt evidence. Typed stops and
 *   rejections (duplicate, conflict, invalid choice, empty rationale)
 *   are asserted on their own dispatches — an arbitrary typed error
 *   standing in for the happy path fails these assertions.
 * - Every dispatch is performed exactly once. There are no automatic
 *   retries after an uncertain execution outcome; a timeout or transport
 *   failure fails the run and the operator inspects it.
 */
import { after, test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  agentDispatcherError,
  getAgentDispatcher,
  initAgentDispatcher,
} from './agent-dispatch-wiring'
import { runtimeSessionIdFor } from './agent-dispatch'
import type { AgentDispatcher, AgentDispatchRequest, AgentDispatchResult } from './agent-dispatch'
import { patchScenario as f } from '../agent-service/fixture'
import { ConsoleEngine } from './state'
import { SqliteRunStore } from './store/sqlite-run-store'
import { SqliteReceiptStore } from './store/sqlite-receipt-store'

const endpoint = process.env.WD_AGENTCORE_ENDPOINT
const machineToken = process.env.WD_MACHINE_TOKEN

/** Filename-safe per Joe's isolated-run requirement and the agent
 * service's session-id slug rule; unique per process invocation. */
function freshTag(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${randomBytes(2).toString('hex')}`
}

/** Marks the test skipped when no endpoint is configured. Returns true
 * when the caller must return immediately (t.skip alone does not halt
 * the test body). */
function skipWithoutEndpoint(t: TestContext): boolean {
  if (endpoint) return false
  t.skip(
    machineToken
      ? 'SKIP: WD_AGENTCORE_ENDPOINT is not set, but WD_MACHINE_TOKEN is — a half-configured host the console itself refuses (ENVIRONMENT_BLOCKED). Set both or neither, then rerun.'
      : 'SKIP: WD_AGENTCORE_ENDPOINT is not configured — there is no deployed runtime to gate against. Set WD_AGENTCORE_ENDPOINT and WD_MACHINE_TOKEN to run the live gate. This skip is explicit and is not AC-6 evidence.',
  )
  return true
}

let dispatcher: AgentDispatcher | undefined

/** The production wiring, initialized in the same order the server does.
 * Any init failure (missing SDK, half-configuration) FAILS here instead
 * of silently degrading to the disabled/deterministic dispatcher. */
function live(): AgentDispatcher {
  if (!dispatcher) {
    initAgentDispatcher()
    const initErr = agentDispatcherError()
    assert.ok(!initErr, `dispatcher init failed — live gate blocked: ${initErr?.message}`)
    const d = getAgentDispatcher()
    assert.ok(
      d.isEnabled(),
      'dispatcher is disabled — deterministic fallback does NOT satisfy the live gate (configure both WD_AGENTCORE_ENDPOINT and WD_MACHINE_TOKEN)',
    )
    dispatcher = d
  }
  return dispatcher
}

async function dispatchOnce(request: AgentDispatchRequest): Promise<AgentDispatchResult> {
  const res = await live().dispatch(request)
  assert.equal(
    res.dispatch.transport,
    'aws-sdk',
    `live gate requires the real AWS SDK transport, got '${res.dispatch.transport}'`,
  )
  assert.equal(
    res.dispatch.runtimeSessionId,
    runtimeSessionIdFor(request.sessionId),
    'runtime session id must derive from the run id (same-session state binding)',
  )
  return res
}

/** Unwrap the agent service envelope {ok, result:{status,...}}. A
 * malformed envelope (non-object, missing typed status) FAILs. */
function phaseResult(res: AgentDispatchResult): Record<string, unknown> {
  assert.ok(res.result !== null && typeof res.result === 'object',
    `malformed response: no invocation envelope (error=${res.error ?? 'none'})`)
  const inner = (res.result as { result?: unknown }).result
  assert.ok(inner !== null && typeof inner === 'object' && typeof (inner as Record<string, unknown>).status === 'string',
    `malformed response: envelope lacks a typed phase result: ${JSON.stringify(res.result).slice(0, 400)}`)
  return inner as Record<string, unknown>
}

/** Assert a decision-run dispatch reaches exactly DECISION_REQUIRED with
 * the scenario's decision request and the tag-bound decision identity. */
function assertPhaseA(res: AgentDispatchResult, tag: string): { decisionId: unknown, invocationA: unknown } {
  assert.equal(res.ok, true, `phase A start failed at the gate: ${res.error ?? 'untyped rejection'}`)
  const result = phaseResult(res)
  assert.equal(result.status, 'DECISION_REQUIRED',
    `phase A must stop exactly at DECISION_REQUIRED, got '${String(result.status)}' (${JSON.stringify(result).slice(0, 300)})`)
  assert.equal(result.decisionId, `decision-svc-${tag}`,
    'decisionId must be bound to this run tag')
  assert.equal(typeof result.invocationA, 'string', 'phase A must report its invocation id')
  assert.ok((result.invocationA as string).length > 0, 'invocationA must be non-empty')
  const request = result.decisionRequest as Record<string, unknown> | undefined
  assert.ok(request !== null && typeof request === 'object', 'phase A must return the decision request')
  assert.equal(request.patchId, `${f.package}-${f.to_version}`, 'decision request patchId must match the scenario')
  assert.equal(request.question, f.decision_request.question, 'decision request question must match the scenario')
  assert.deepEqual(request.options, f.decision_request.options, 'decision request options must match the scenario')
  return { decisionId: result.decisionId, invocationA: result.invocationA }
}

/** Assert an approved resume reaches exactly COMPLETED with the run/
 * decision binding and receipt evidence (the COMPLETED happy path — a
 * typed stop or rejection here fails the gate). */
function assertCompleted(res: AgentDispatchResult, decisionId: unknown, invocationA: unknown, choice: string): { invocationB: unknown, receiptId: unknown } {
  assert.equal(res.ok, true, `approved resume failed at the gate: ${res.error ?? 'untyped rejection'}`)
  const result = phaseResult(res)
  assert.equal(result.status, 'COMPLETED',
    `the approved happy path must complete exactly, got '${String(result.status)}' (${JSON.stringify(result).slice(0, 300)})`)
  assert.equal(result.decisionId, decisionId, 'phase B must resume the SAME decision phase A opened')
  assert.equal(typeof result.invocationB, 'string', 'phase B must report a successor invocation id')
  assert.notEqual(result.invocationB, invocationA, 'phase B must be a NEW successor invocation, not a replay of A')
  assert.equal(typeof result.receiptId, 'string', 'phase B must report a consumption receipt id')
  assert.ok((result.receiptId as string).length > 0, 'receiptId must be non-empty')
  const effect = result.effect as Record<string, unknown> | undefined
  assert.ok(effect !== null && typeof effect === 'object', 'phase B must return the effect receipt')
  assert.equal(effect.effect, choice, 'executed effect must equal the approved choice')
  assert.equal(effect.mode, 'dry-run', 'the prepared effect stays a dry-run')
  assert.equal(effect.noExternalMutationPerformed, true, 'no external mutation may be performed')
  const authorizedBy = effect.authorizedBy as Record<string, unknown> | undefined
  assert.ok(authorizedBy !== null && typeof authorizedBy === 'object', 'effect must record its authorization')
  assert.equal(authorizedBy.decisionId, decisionId, 'effect authorization must reference this decision')
  assert.equal(authorizedBy.successorInvocationId, result.invocationB, 'effect authorization must reference the successor invocation')
  assert.equal(authorizedBy.consumptionReceiptId, result.receiptId, 'effect authorization must reference the consumption receipt')
  return { invocationB: result.invocationB, receiptId: result.receiptId }
}

// State threaded through the sequential run-1 lifecycle tests.
let run1: { tag: string, decisionId: unknown, invocationA: unknown, choice: string, rationale: string, receiptId: unknown } | undefined
let consoleEngine: ConsoleEngine | undefined
let consoleDir: string | undefined

after(async () => {
  if (consoleEngine) await consoleEngine.close()
  if (consoleDir) rmSync(consoleDir, { recursive: true, force: true })
})

test('AC-6 phase A: fresh live run reaches DECISION_REQUIRED', { timeout: 300_000 }, async t => {
  if (skipWithoutEndpoint(t)) return
  consoleDir = mkdtempSync(path.join(os.tmpdir(), 'wd-agentcore-live-gate-'))
  consoleEngine = new ConsoleEngine(freshTag('wdac6-tenant'), {
    runs: new SqliteRunStore(consoleDir),
    receipts: new SqliteReceiptStore(path.join(consoleDir, 'consumption.db')),
  })
  const { runId } = await consoleEngine.startRun(false, live())
  const dispatched = await consoleEngine.dispatchStart(runId, live())
  assert.equal(dispatched.ok, true, `console dispatchStart failed: ${dispatched.error ?? 'untyped rejection'}`)

  const state = await consoleEngine.getState()
  assert.equal(state.runId, runId, 'console readback must remain bound to the started run')
  assert.equal(state.executionMode, 'agentcore', 'console must persist the live execution mode')
  assert.equal(state.state, 'decision_required', 'console must render the live human-decision gate')
  assert.ok(state.agent, 'console must persist the live start dispatch evidence')
  assert.equal(state.agent.dispatch.transport, 'aws-sdk', 'console readback must retain the live transport')
  assert.equal(state.decisionRequest?.question, f.decision_request.question, 'console must render the live decision question')
  assert.deepEqual(state.decisionRequest?.options, f.decision_request.options, 'console must render the live decision options')
  const opened = assertPhaseA(state.agent, runId)
  run1 = { tag: runId, decisionId: opened.decisionId, invocationA: opened.invocationA, choice: f.human_choice.decision, rationale: f.human_choice.rationale, receiptId: undefined }
})

test('AC-6 phase B: approved decision resumes the same run to COMPLETED with bound evidence', { timeout: 300_000 }, async t => {
  if (skipWithoutEndpoint(t)) return
  if (!run1 || !consoleEngine) return t.skip('phase A did not produce a console run to resume')
  const submitted = await consoleEngine.submitDecision(
    run1.choice,
    run1.rationale,
    `live-gate-${run1.tag}`,
    undefined,
    run1.tag,
    live(),
  )
  assert.equal(submitted.ok, true, `console submitDecision failed: ${submitted.error ?? 'untyped rejection'}`)

  const state = await consoleEngine.getState()
  assert.equal(state.state, 'completed', 'console must persist and render completion')
  assert.deepEqual(state.decision, {
    choice: run1.choice,
    rationale: run1.rationale,
    decidedAt: state.decision?.decidedAt,
  }, 'console must persist the exact approved choice and rationale')
  assert.ok(state.decision?.decidedAt, 'console decision must carry its decision time')
  assert.ok(state.consumption?.receiptId, 'console must persist its one-use consumption receipt')
  assert.equal(state.effect?.effect, run1.choice, 'console effect must match the approved choice')
  assert.equal(state.effect?.noExternalMutationPerformed, true, 'console effect must remain non-mutating')
  assert.ok(state.agent, 'console must persist the live resume dispatch evidence')
  assert.equal(state.agent.dispatch.transport, 'aws-sdk', 'completed console readback must retain the live transport')
  for (const name of ['human-decision', 'consumption-receipt', 'effect-receipt', 'agent-report', 'agent-resume']) {
    assert.ok(state.artifacts.some(artifact => artifact.name === name && artifact.valid), `console must expose valid ${name} evidence`)
  }
  const done = assertCompleted(state.agent, run1.decisionId, run1.invocationA, run1.choice)
  run1.receiptId = done.receiptId
})

test('AC-6 idempotency: identical resume returns DUPLICATE without a new successor', { timeout: 300_000 }, async t => {
  if (skipWithoutEndpoint(t)) return
  if (!run1?.receiptId) return t.skip('phase B did not complete a run to replay')
  const res = await dispatchOnce({
    kind: 'decision-resume', sessionId: run1.tag,
    choice: run1.choice, rationale: run1.rationale,
  })
  assert.equal(res.ok, true, 'an identical resume must succeed as a duplicate')
  const result = phaseResult(res)
  assert.equal(result.status, 'DUPLICATE', `expected the typed DUPLICATE result, got '${String(result.status)}'`)
  assert.equal(result.decisionId, run1.decisionId, 'duplicate must reference the same decision')
  assert.equal(result.receiptId, run1.receiptId, 'duplicate must reference the original receipt')
  assert.equal(result.invocationB, undefined, 'a duplicate must not mint a new successor invocation')
})

test('AC-6 conflict: a different decision on the completed run is rejected', { timeout: 300_000 }, async t => {
  if (skipWithoutEndpoint(t)) return
  if (!run1?.receiptId) return t.skip('phase B did not complete a run to conflict against')
  const conflicting = f.decision_request.options.find(o => o !== run1!.choice)!
  const res = await dispatchOnce({
    kind: 'decision-resume', sessionId: run1.tag,
    choice: conflicting, rationale: `live-gate conflict probe — must not execute (${conflicting})`,
  })
  assert.equal(res.ok, false, 'a conflicting decision must not be accepted')
  const result = phaseResult(res)
  assert.equal(result.status, 'STATE_CONFLICT', `expected the typed STATE_CONFLICT rejection, got '${String(result.status)}'`)
  // The original decision must still be the only one on the run.
  const replay = await dispatchOnce({
    kind: 'decision-resume', sessionId: run1.tag,
    choice: run1.choice, rationale: run1.rationale,
  })
  assert.equal(phaseResult(replay).status, 'DUPLICATE', 'the original decision must remain the recorded one')
  assert.equal(phaseResult(replay).receiptId, run1.receiptId, 'the original receipt must be unchanged')
})

test('AC-6 conflict: the recorded choice cannot be replayed with a different rationale', { timeout: 300_000 }, async t => {
  if (skipWithoutEndpoint(t)) return
  if (!run1?.receiptId) return t.skip('phase B did not complete a run to conflict against')
  const res = await dispatchOnce({
    kind: 'decision-resume', sessionId: run1.tag,
    choice: run1.choice, rationale: `${run1.rationale} (conflicting rationale probe)`,
  })
  assert.equal(res.ok, false, 'a rationale-only conflict must not be accepted')
  const result = phaseResult(res)
  assert.equal(result.status, 'STATE_CONFLICT', `expected the typed STATE_CONFLICT rejection, got '${String(result.status)}'`)

  const replay = await dispatchOnce({
    kind: 'decision-resume', sessionId: run1.tag,
    choice: run1.choice, rationale: run1.rationale,
  })
  assert.equal(phaseResult(replay).status, 'DUPLICATE', 'the exact original decision must remain replayable')
  assert.equal(phaseResult(replay).receiptId, run1.receiptId, 'the original receipt must remain unchanged')
})

test('AC-6 rejection discipline: typed resume rejections do not advance a fresh run', { timeout: 300_000 }, async t => {
  if (skipWithoutEndpoint(t)) return
  const tag = freshTag('wdac6b')
  const opened = assertPhaseA(await dispatchOnce({ kind: 'decision-run', sessionId: tag }), tag)

  // An unknown choice is rejected before any model call; the run stays at
  // its decision point.
  const invalid = await dispatchOnce({
    kind: 'decision-resume', sessionId: tag,
    choice: '__not_a_real_option__', rationale: 'live-gate invalid-choice probe',
  })
  assert.equal(invalid.ok, false, 'an unknown choice must not be accepted')
  const invalidResult = phaseResult(invalid)
  assert.equal(invalidResult.status, 'INVALID_INPUT', `expected the typed INVALID_INPUT rejection, got '${String(invalidResult.status)}'`)
  assert.match(String(invalidResult.reason), /^INVALID_CHOICE/, 'the rejection must name the invalid choice')

  // An empty rationale is invalid, never defaulted.
  const emptyRationale = await dispatchOnce({
    kind: 'decision-resume', sessionId: tag,
    choice: f.human_choice.decision, rationale: '',
  })
  assert.equal(emptyRationale.ok, false, 'an empty rationale must not be accepted')
  const emptyResult = phaseResult(emptyRationale)
  assert.equal(emptyResult.status, 'INVALID_INPUT', `expected the typed INVALID_INPUT rejection, got '${String(emptyResult.status)}'`)
  assert.equal(emptyResult.reason, 'RATIONALE_REQUIRED', 'the rejection must require the rationale')

  // The typed rejections consumed nothing: the approved decision still
  // completes this same run with the full binding evidence.
  const done = assertCompleted(
    await dispatchOnce({ kind: 'decision-resume', sessionId: tag, choice: f.human_choice.decision, rationale: f.human_choice.rationale }),
    opened.decisionId, opened.invocationA, f.human_choice.decision,
  )
  assert.ok(done.receiptId, 'the rejection-probe run must close with a receipt')
})
