/* The two-phase agent lifecycle for the AgentCore HTTP service. The CLI
 * (src/live-loop.ts) runs both phases in one process with the decision
 * bound up front; the service runs them as SEPARATE invocations — phase A
 * ends at the interrupt, phase B resumes from the persisted snapshot with
 * the human's decision. This is the M1 ruling in service form: terminal
 * stop + seeded resume, nothing hovers.
 *
 * Every invariant from the review sagas rides along via the shared
 * modules: durable IO (agent-core/durable), claim-gates-execution
 * (ConsumptionStore), receipt validation, interrupt verification,
 * first-writer-wins artifacts. The state machine here adds ONE phase the
 * CLI never produces: 'awaiting_decision' — the honest state of a run
 * stopped at its decision point, waiting for the human. */
import { existsSync, readFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { Agent, InterruptResponseContent } from '@strands-agents/sdk'
import type { Interrupt } from '@strands-agents/sdk'
import {
  buildTaskPacket, buildReviewFindings, buildStopResponse, buildHumanDecision,
  buildAgentReport,
} from '../artifacts/build'
import type { Scenario } from '../artifacts/build'
import { assertValid } from '../artifacts/schemas'
import { ConsumptionStore, decisionDigest } from '../consumption/store'
import type { DecisionRecord } from '../consumption/store'
import { loadProvider } from '../provider'
import { decisionTool, promptFor } from './tool'
import { assertSafeSlug, mkdirDurable, reserveExclusive, saveRunState, syncDir, writeDurableJson } from './durable'
import type { AgentRuntime, ResumeInput, ResumeOutput, RunState, StartInput, StartOutput } from './types'

export type ServiceContext = {
  /** Root for all per-run state, snapshots, leases, artifacts. On the
   * AgentCore runtime this is the persistent mount (e.g. /mnt/data/agent);
   * locally .tmp/agent-service. */
  dataDir: string
  /** The claim database — must survive across runs (consume-once). */
  claimDb: string
  fixture: Scenario
}

export type RuntimeFactory = (fixture: Scenario) => AgentRuntime

export const defaultRuntimeFactory: RuntimeFactory = (fixture) => {
  const { model, provenance } = loadProvider()
  return { agent: new Agent({ model, tools: [decisionTool(fixture)] }), provenance }
}

type ServiceRunState = RunState & { phase: RunState['phase'] | 'awaiting_decision' }

function stateFile(ctx: ServiceContext, tag: string) { return path.join(ctx.dataDir, `state-${tag}.json`) }
function snapshotFile(ctx: ServiceContext, tag: string) { return path.join(ctx.dataDir, `snapshot-${tag}.json`) }
function leaseFile(ctx: ServiceContext, tag: string) { return path.join(ctx.dataDir, `lease-${tag}.json`) }
function runDir(ctx: ServiceContext, tag: string) { return path.join(ctx.dataDir, 'runs', tag) }

function loadServiceState(ctx: ServiceContext, tag: string): ServiceRunState | null {
  const file = stateFile(ctx, tag)
  if (!existsSync(file)) return null
  return JSON.parse(readFileSync(file, 'utf8')) as ServiceRunState
}

function writeArtifact(ctx: ServiceContext, tag: string, name: string, value: unknown): void {
  writeDurableJson(path.join(runDir(ctx, tag), name), value)
}

// ─── Phase A: start a run to its decision point ───────────────────────────

export async function startPhase(ctx: ServiceContext, input: StartInput, runtimeFactory: RuntimeFactory = defaultRuntimeFactory): Promise<StartOutput> {
  assertSafeSlug(input.tag, 'TAG')
  const prior = loadServiceState(ctx, input.tag)

  if (prior?.phase === 'completed') {
    return { status: 'RUN_ALREADY_COMPLETED', decisionId: prior.decisionId, invocationB: prior.invocationB, receiptId: prior.receiptId }
  }
  if (prior?.phase === 'rejected') {
    return { status: 'RUN_PREVIOUSLY_REJECTED', outcome: prior.outcome ?? 'rejected' }
  }
  if (prior) {
    // awaiting_decision is the normal service state — the decision POST is
    // the next move. claimed means a crash between intent and completion:
    // automatic recovery stays disabled (the review-ruled posture).
    if (prior.phase === 'awaiting_decision') {
      return { status: 'DECISION_REQUIRED', decisionId: prior.decisionId, invocationA: prior.invocationA, decisionRequest: decisionRequestOf(ctx) }
    }
    return { status: 'HUMAN_DECISION_REQUIRED', reason: `prior run is ${prior.phase}; automatic recovery is disabled` }
  }
  if (existsSync(snapshotFile(ctx, input.tag))) {
    return { status: 'HUMAN_DECISION_REQUIRED', reason: 'snapshot exists without state; unknown outcome, automatic recovery disabled' }
  }

  mkdirDurable(ctx.dataDir)
  if (!reserveExclusive(leaseFile(ctx, input.tag))) {
    return { status: 'ENVIRONMENT_BLOCKED', reason: 'tag is already reserved; holder death does not authorize takeover' }
  }
  mkdirDurable(runDir(ctx, input.tag))

  const { agent, provenance } = runtimeFactory(ctx.fixture)
  const invocationA = `inv-${randomUUID()}`

  // ── Invocation A: real model, real interrupt, verified ────────────────
  const first = await agent.invoke(promptFor(ctx.fixture))
  const interrupts: Interrupt[] = first.interrupts ?? []
  if (interrupts.length !== 1 || first.stopReason !== 'interrupt') {
    throw new Error(`INVARIANT: expected exactly one interrupt stop, got stopReason=${first.stopReason}, interrupts=${interrupts.length}`)
  }
  const expectedPatchId = `${ctx.fixture.package}-${ctx.fixture.to_version}`
  const reason = interrupts[0]!.reason as { question?: string, patchId?: string, options?: string[] }
  if (interrupts[0]!.name !== 'human_release_decision'
    || reason?.question !== ctx.fixture.decision_request.question
    || reason?.patchId !== expectedPatchId
    || JSON.stringify(reason?.options) !== JSON.stringify(ctx.fixture.decision_request.options)) {
    throw new Error(`INVARIANT: interrupt does not match the scenario (name=${interrupts[0]!.name}, patchId=${reason?.patchId}, expected ${expectedPatchId})`)
  }

  // Persist the resumable session BEFORE any state write (the successor
  // identity and resumable state must survive a crash after the claim).
  writeDurableJson(snapshotFile(ctx, input.tag), agent.takeSnapshot({ preset: 'session' }))

  // ── Spine artifacts (validated, durable) ────────────────────────────────
  const packet = buildTaskPacket(ctx.fixture)
  assertValid('task-packet', packet)
  const findings = buildReviewFindings(ctx.fixture)
  for (const finding of findings) assertValid('review-finding', finding)
  const stop = buildStopResponse(ctx.fixture)
  assertValid('stop-response', stop)
  writeArtifact(ctx, input.tag, '01-task-packet.json', packet)
  writeArtifact(ctx, input.tag, '02-review-findings.json', findings)
  writeArtifact(ctx, input.tag, '03-stop-response.json', stop)
  syncDir(runDir(ctx, input.tag))

  // State: awaiting the human decision. The decisionId is derived from the
  // tag so phase B can reconstruct it without in-memory handoff.
  const state: ServiceRunState = {
    phase: 'awaiting_decision',
    decisionId: `decision-svc-${input.tag}`,
    choice: '', rationale: '', decidedAt: '',
    invocationA,
    invocationB: `inv-${randomUUID()}`,
  }
  saveRunState(stateFile(ctx, input.tag), state)

  return { status: 'DECISION_REQUIRED', decisionId: state.decisionId, invocationA, decisionRequest: decisionRequestOf(ctx) }
}

function decisionRequestOf(ctx: ServiceContext) {
  const f = ctx.fixture
  return {
    question: f.decision_request.question,
    patchId: `${f.package}-${f.to_version}`,
    options: f.decision_request.options,
    tradeoff: f.tradeoff.who_is_affected,
  }
}

// ─── Phase B: resume with the recorded human decision ─────────────────────

export async function resumePhase(ctx: ServiceContext, input: ResumeInput, runtimeFactory: RuntimeFactory = defaultRuntimeFactory): Promise<ResumeOutput> {
  assertSafeSlug(input.tag, 'TAG')
  const prior = loadServiceState(ctx, input.tag)
  if (!prior) return { status: 'INVALID_INPUT', reason: `no run started for tag ${input.tag}` }
  if (prior.phase === 'completed') {
    return { status: 'DUPLICATE', decisionId: prior.decisionId, receiptId: prior.receiptId }
  }
  if (prior.phase !== 'awaiting_decision') {
    return { status: 'HUMAN_DECISION_REQUIRED', reason: `run is ${prior.phase}; automatic recovery is disabled` }
  }
  const f = ctx.fixture
  if (!f.decision_request.options.includes(input.choice)) {
    return { status: 'INVALID_INPUT', reason: `INVALID_CHOICE:${input.choice}` }
  }
  // The service requires the human's actual rationale — no CLI-style
  // defaults here; an empty submission is invalid, not defaulted.
  const rationale = input.rationale ?? ''
  if (rationale.trim().length === 0) {
    return { status: 'INVALID_INPUT', reason: 'RATIONALE_REQUIRED' }
  }
  if (prior.choice && (prior.choice !== input.choice)) {
    return { status: 'STATE_CONFLICT', reason: `tag already holds a ${prior.phase} decision (${prior.choice})` }
  }

  // ── Claim BEFORE resume — the claim gates execution ─────────────────────
  const decidedAt = new Date().toISOString()
  const state: ServiceRunState = { ...prior, phase: 'claimed', choice: input.choice, rationale, decidedAt }
  saveRunState(stateFile(ctx, input.tag), state)

  const decisionRecord: DecisionRecord = {
    decisionId: state.decisionId,
    chosenOption: state.choice,
    rationale: state.rationale,
    decidedAt: state.decidedAt,
    decisionRequestId: f.stop_id,
    permittedAction: 'dry-run receipt for the approved branch (no external mutation)',
  }
  const store = new ConsumptionStore(ctx.claimDb)
  const claim = store.claim(decisionRecord, state.invocationB, decisionDigest(decisionRecord))
  if (claim.status === 'rejected') {
    store.close()
    const outcome = `DECISION_ALREADY_CLAIMED:${claim.reason} — ${claim.detail}`
    saveRunState(stateFile(ctx, input.tag), { ...state, phase: 'rejected', outcome })
    return { status: 'CLAIM_REJECTED', reason: outcome }
  }
  if (claim.status === 'replayed') {
    store.close()
    return { status: 'HUMAN_DECISION_REQUIRED', reason: 'existing claim does not authorize reexecution' }
  }

  // ── Invocation B: reconstruct the agent from the snapshot, resume ───────
  // A FRESH runtime is built and loaded from the persisted snapshot — this
  // is the cross-instance resume the service exists to prove (a new
  // microVM with the same session state behaves identically).
  const snapshot = JSON.parse(readFileSync(snapshotFile(ctx, input.tag), 'utf8')) as Parameters<Agent['loadSnapshot']>[0]
  const { agent } = runtimeFactory(f)
  agent.loadSnapshot(snapshot)
  const interruptId = interruptIdFromSnapshot(snapshot)
  const resumed = await agent.invoke([
    new InterruptResponseContent({ interruptId, response: { choice: state.choice, rationale: state.rationale } }),
  ])
  if (resumed.stopReason !== 'endTurn') {
    store.close()
    throw new Error(`INVARIANT: resume should end the turn, got ${resumed.stopReason}`)
  }

  // Live duplicate probe: a second successor must fail closed.
  const imposter = `inv-${randomUUID()}`
  const duplicate = store.claim(decisionRecord, imposter)
  store.close()
  if (duplicate.status !== 'rejected' || duplicate.reason !== 'competing_successor') {
    throw new Error('INVARIANT: duplicate claim did not fail closed')
  }

  // ── Artifacts from runtime truth ─────────────────────────────────────────
  const runtimeDecision = { decisionId: state.decisionId, choice: state.choice, rationale: state.rationale, decidedAt: state.decidedAt }
  const stopBytes = JSON.stringify(buildStopResponse(f), null, 2)
  const evidenceDigest = createHash('sha256').update(stopBytes).digest('hex')
  const humanDecision = buildHumanDecision(f, runtimeDecision, evidenceDigest, {
    channel: {
      interaction: 'api',
      sessionReference: `agentcore-service:${input.tag}`,
      authEventRef: 'operator-session',
    },
  })
  assertValid('human-decision', humanDecision)

  const effect = {
    schema: 'who-decides.effect-receipt.v0',
    effect: state.choice,
    mode: 'dry-run',
    exactPayload: state.choice === 'create_draft_pr'
      ? { repo: 'example/kestrel-app', title: `Security: ${f.package} ${f.to_version}`, branch: `security/${f.package}-${f.to_version}`, payloadSource: 'host-constructed from fixture (model output advisory only)' }
      : { outcome: state.choice === 'send_back' ? 'no PR created — work returned' : 'nothing executed — deferred', payloadSource: 'host-constructed from fixture (model output advisory only)' },
    noExternalMutationPerformed: true,
    authorizedBy: { decisionId: state.decisionId, consumptionReceiptId: claim.receipt.receiptId, successorInvocationId: state.invocationB },
  }
  const report = buildAgentReport(f, runtimeDecision, claim.receipt.receiptId, claim.receipt.decisionDigest.replace('sha256:', ''), { simulatedWorkspace: true })
  assertValid('agent-report', report)

  writeArtifact(ctx, input.tag, '04-human-decision.json', humanDecision)
  writeArtifact(ctx, input.tag, '05-consumption-receipt.json', claim.receipt)
  writeArtifact(ctx, input.tag, '06-effect-receipt.json', effect)
  writeArtifact(ctx, input.tag, '07-agent-report.json', report)
  writeArtifact(ctx, input.tag, '00-service-run-summary.json', {
    tag: input.tag, decisionId: state.decisionId, invocationA: state.invocationA, invocationB: state.invocationB,
    humanChoice: state.choice, receiptId: claim.receipt.receiptId, duplicateProbe: 'REJECTED (competing_successor)',
  })
  syncDir(runDir(ctx, input.tag))
  saveRunState(stateFile(ctx, input.tag), { ...state, phase: 'completed', receiptId: claim.receipt.receiptId })

  return { status: 'COMPLETED', decisionId: state.decisionId, invocationB: state.invocationB, receiptId: claim.receipt.receiptId, effect }
}

/** The interrupt id nested inside a session snapshot (the t2 spike lesson:
 * the map lives at data.interrupts.interrupts). */
function interruptIdFromSnapshot(snapshot: unknown): string {
  const data = (snapshot as { data?: { interrupts?: { interrupts?: Record<string, { id: string }> } } }).data
  const map = data?.interrupts?.interrupts
  const first = map && Object.values(map)[0]
  if (!first?.id) throw new Error('SNAPSHOT_INVALID:no-interrupt-id')
  return first.id
}
