/* Console state engine — the deterministic spine behind the M3 console.
 * Durable server records are authoritative (RULING M3); the browser only
 * polls. State machine: ready → running → decision_required → resuming →
 * completed, plus typed stops. The running phase advances on wall-clock so
 * the timeline is visible without background timers.
 *
 * Storage goes through the async provider seam in ./store — SQLite by
 * default (zero-config local demo), Postgres adapter for the hosted demo.
 * All engine methods are async for that reason. */
import type { AgentDispatcher, AgentDispatchResult } from './agent-dispatch'
import { randomUUID, createHash } from 'node:crypto'
import path from 'node:path'
import { assertValid, validateArtifact } from '../artifacts/schemas'
import type { ArtifactKind } from '../artifacts/schemas'
import {
  buildTaskPacket, buildReviewFindings, buildStopResponse, buildHumanDecision,
  buildAgentReport, scopeScenario,
} from '../artifacts/build'
import type { Scenario } from '../artifacts/build'
import { decisionDigest } from '../consumption/store'
import type { DecisionRecord } from '../consumption/store'
import { patchScenario } from '../agent-service/fixture'
import type { RunStore } from './store/store'
import { createDefaultRunStore, createDefaultReceiptStore } from './store/factory'
import type { ReceiptStore } from './store/sqlite-receipt-store'

const DB_DIR = process.env.WD_CONSOLE_DIR ?? path.resolve(process.cwd(), '.tmp/console')
const RUN_RUNNING_MS = 2600
const RUN_RESUMING_MS = 1800

export type RunState = 'running' | 'decision_required' | 'resuming' | 'completed' | 'blocked'

export type Milestone = { label: string, detail: string, at: string }

type DecisionChannel = { sessionReference: string, authEventRef: string }
type StoredDecision = {
  choice: string
  rationale: string
  decidedAt: string
  idempotencyKey: string | null
  // Absent on legacy/unauthenticated intents; never infer from a retry.
  channel?: DecisionChannel
}

export type ConsoleState = {
  schema: 'who-decides.console-state.v1'
  tenantId: string
  executionMode: string
  agent: AgentDispatchResult | null
  runId: string
  state: RunState | 'ready'
  invocationA: string | null
  invocationB: string | null
  startedAt: string | null
  completedAt: string | null
  milestones: Milestone[]
  decisionRequest: {
    question: string
    options: string[]
    humanTerms: string
    whoIsAffected: string
    tradeoffFindingId: string
  } | null
  decision: { choice: string, rationale: string, decidedAt: string } | null
  consumption: { receiptId: string, decisionDigest: string, successorInvocationId: string, claimedAt: string } | null
  replayProbe: { attemptedBy: string, result: string, detail: string } | null
  effect: { effect: string, mode: string, noExternalMutationPerformed: boolean, exactPayload: Record<string, unknown> } | null
  artifacts: Array<{ name: string, kind: ArtifactKind | 'consumption-receipt' | 'effect-receipt' | 'agent-dispatch', valid: boolean }>
  heading: string
  subheading: string
}

const HEADING: Record<ConsoleState['state'] & string, { heading: string, subheading: string }> = {
  blocked: { heading: 'Live run stopped', subheading: 'The agent did not confirm completion. Inspect the recorded result before starting a new run.' },
  ready: { heading: 'Ready', subheading: 'One click starts invocation A. It never preselects your decision.' },
  running: { heading: 'Running', subheading: 'The agent works in the background. You are not needed yet.' },
  decision_required: { heading: 'Decision required — waiting for you', subheading: 'Invocation A has ended. Nothing will happen until you decide.' },
  resuming: { heading: 'New invocation started from your decision', subheading: 'Invocation B claimed the decision and is executing only the approved branch.' },
  completed: { heading: 'Complete', subheading: 'The decision was consumed exactly once. No external mutation was performed.' },
}

/* Structural validators for the two who-decides receipt kinds — they are not
 * HACP v0.1-draft artifacts, but they must never get a green check for free
 * (Qodo #5 / Codex P2). A malformed receipt fails the write. */
function validateReceipt(kind: 'consumption-receipt' | 'effect-receipt', artifact: unknown): boolean {
  if (typeof artifact !== 'object' || artifact === null) return false
  const r = artifact as Record<string, unknown>
  if (kind === 'consumption-receipt') {
    return r.schema === 'who-decides.consumption-receipt.v0'
      && typeof r.receiptId === 'string' && r.receiptId.length > 0
      && typeof r.decisionId === 'string' && r.decisionId.length > 0
      && typeof r.decisionDigest === 'string' && (r.decisionDigest as string).startsWith('sha256:')
      && typeof r.decisionRequestId === 'string' && r.decisionRequestId.length > 0
      && typeof r.permittedAction === 'string' && r.permittedAction.length > 0
      && typeof r.successorInvocationId === 'string' && r.successorInvocationId.length > 0
      && typeof r.claimedAt === 'string' && r.claimedAt.length > 0
      && typeof r.claimNote === 'string' && r.claimNote.length > 0
  }
  return r.schema === 'who-decides.effect-receipt.v0'
    && typeof r.effect === 'string' && r.effect.length > 0
    && r.mode === 'dry-run'
    && r.noExternalMutationPerformed === true
    && typeof r.exactPayload === 'object' && r.exactPayload !== null
    && typeof (r.authorizedBy as Record<string, unknown> | undefined)?.decisionId === 'string'
    && typeof (r.authorizedBy as Record<string, unknown> | undefined)?.consumptionReceiptId === 'string'
    && typeof (r.authorizedBy as Record<string, unknown> | undefined)?.successorInvocationId === 'string'
}

export class ConsoleEngine {
  private readonly runs: RunStore
  private readonly receipts: ReceiptStore
  private readonly ready: Promise<void>
  /** Runs whose live resume dispatch is currently being awaited by THIS
   * process. Reset refuses to archive an in-flight resume even before its
   * confirmation artifact exists — the durable artifact check alone cannot
   * distinguish in-flight from crashed-without-evidence. */
  private readonly inflightResumes = new Set<string>()
  /** Known-tenant scoping: one engine instance serves one tenant's runs.
   * Multi-process deployments run one process per tenant, or one process per
   * tenant pool, with separate state directories. The default keeps the
   * single-operator local demo behavior unchanged. */
  readonly tenant: string

  constructor(tenant: string = process.env.WD_TENANT_ID ?? 'default', stores?: { runs?: RunStore, receipts?: ReceiptStore }) {
    this.tenant = tenant
    const dir = process.env.WD_CONSOLE_DIR ?? DB_DIR
    // Backend selection (WD_STORE=sqlite|postgres) lives in the factory;
    // the engine itself never branches on the storage backend. Each missing
    // store is defaulted independently, so partial injection never builds
    // an unused adapter that close() could not reach.
    this.runs = stores?.runs ?? createDefaultRunStore(dir)
    this.receipts = stores?.receipts ?? createDefaultReceiptStore(dir)
    // The provider seam's initialize() is async (a Postgres adapter must be);
    // the engine bridges that with a ready-promise so constructors stay sync.
    this.ready = this.runs.initialize()
  }

  private async currentRun() {
    await this.ready
    return this.runs.getCurrentRun(this.tenant)
  }

  async startRun(retried = false, dispatcher?: AgentDispatcher): Promise<{ runId: string }> {
    await this.ready
    const s = patchScenario
    const runId = `run-${randomUUID()}`
    const invocationA = `inv-${randomUUID()}`
    const now = new Date().toISOString()
    const milestones: Milestone[] = [
      { label: 'inspect', detail: `${s.package} ${s.from_version} → ${s.to_version} (${s.advisory})`, at: now },
      { label: 'update', detail: `package.json + lockfile prepared`, at: now },
      { label: 'test', detail: s.checks.unit, at: now },
      { label: 'build', detail: s.checks.build, at: now },
    ]
    // One-active-run enforced atomically inside the store (adapter-level
    // check-and-insert): a concurrent caller cannot slip a second active run
    // between check and insert.
    const active = await this.runs.ensureActiveRun(this.tenant, {
      id: runId, tenantId: this.tenant, invocationA,
      startedAt: now, phaseChangedAt: now, milestonesJson: JSON.stringify(milestones),
      executionMode: dispatcher?.isEnabled() ? 'agentcore' : 'deterministic',
    })
    if (active.id !== runId) {
      // Another caller provisioned this run moments ago. Provisioning is
      // idempotent: repair any missing artifacts. If the run is still in its
      // provisioning state, complete it; if it was retracted mid-repair
      // (creator failed first), start fresh ONCE instead of returning a dead
      // id. A run already past provisioning just needs the artifact repair.
      await this.provisionArtifacts(active.id)
      if (active.state !== 'provisioning') return { runId: active.id }
      if (await this.completeProvisioning(active.id)) return { runId: active.id }
      if (retried) throw new Error('PROVISIONING_RETRY_EXHAUSTED')
      return await this.startRun(true, dispatcher)
    }

    try {
      await this.provisionArtifacts(runId)
      if (!(await this.completeProvisioning(runId))) {
        throw new Error(`PROVISIONING_RETRACTED:${runId}`)
      }
    } catch (err) {
      // Retract the incompletely provisioned run (only retractable while
      // still in the provisioning state) so the next start creates a fresh
      // one instead of inheriting a run with missing evidence.
      await this.runs.retractProvisioningRun(runId).catch(() => { /* best-effort cleanup */ })
      throw err
    }
    return { runId }
  }

  /** A lost provisioning CAS can mean another caller finished the same
   * work. Network I/O lets repair overtake the creator, so distinguish that
   * success from retraction without changing markProvisioned's CAS result. */
  private async completeProvisioning(runId: string): Promise<boolean> {
    if (await this.runs.markProvisioned(runId)) return true
    const row = await this.runs.getRunRow(runId)
    return row !== undefined && Number(row.archived) === 0
      && ['running', 'starting', 'decision_required', 'resuming', 'completed', 'blocked'].includes(row.state ?? '')
  }

  /** Writes the invocation-A artifacts idempotently — the builders are
   * deterministic, so any caller can complete or repair provisioning. */
  private async provisionArtifacts(runId: string): Promise<void> {
    const s = scopeScenario(patchScenario, runId)
    const packet = buildTaskPacket(s)
    assertValid('task-packet', packet)
    if (await this.runs.getArtifactJson(runId, 'task-packet') === undefined) {
      await this.storeArtifact(runId, 'task-packet', 'task-packet', packet)
    }
    const findings = buildReviewFindings(s)
    for (const [i, finding] of findings.entries()) {
      assertValid('review-finding', finding)
      const name = i === 0 ? 'review-finding-green' : 'review-finding-tradeoff'
      if (await this.runs.getArtifactJson(runId, name) === undefined) {
        await this.storeArtifact(runId, name, 'review-finding', finding)
      }
    }
    const stop = buildStopResponse(s)
    assertValid('stop-response', stop)
    if (await this.runs.getArtifactJson(runId, 'stop-response') === undefined) {
      await this.storeArtifact(runId, 'stop-response', 'stop-response', stop)
    }
  }

  /** Wall-clock phase advance — deterministic, no timers. Transitions are
   * compare-and-swap: a stale poller losing the race must not overwrite a
   * newer phase (e.g. flip a consumed run back to decision_required). The
   * local object only advances when the CAS won. */
  private async advancePhases(run: { id: string, state: string, phase_changed_at: string, execution_mode?: string }): Promise<void> {
    if (run.execution_mode === 'agentcore') return
    const elapsed = Date.now() - Date.parse(run.phase_changed_at)
    if (run.state === 'running' && elapsed >= RUN_RUNNING_MS) {
      const won = await this.runs.updateRunPhase(run.id, 'running', 'decision_required', new Date().toISOString())
      if (won) run.state = 'decision_required'
    }
    const elapsed2 = Date.now() - Date.parse(run.phase_changed_at)
    if (run.state === 'resuming' && elapsed2 >= RUN_RESUMING_MS) {
      const now = new Date().toISOString()
      const won = await this.runs.updateRunPhase(run.id, 'resuming', 'completed', now, now)
      if (won) run.state = 'completed'
    }
  }

  /** `channel` carries the authenticated operator's session metadata (from
   * the passcode gate) into the human-decision audit artifact — an
   * authenticated console decision must never be recorded with the
   * unauthenticated demo defaults. Engine-level callers (tests, scenario,
   * CLI) omit it and keep the honest demo defaults. */
  async submitDecision(choice: string, rationale: string, idempotencyKey?: string, channel?: DecisionChannel, expectedRunId?: string, dispatcher?: AgentDispatcher): Promise<{ ok: boolean, duplicate?: boolean, error?: string }> {
    const run = await this.currentRun()
    if (!run) return { ok: false, error: 'NO_RUN' }
    if (expectedRunId !== undefined && run.id !== expectedRunId) return { ok: false, error: 'RUN_CHANGED' }
    await this.advancePhases(run)
    // Authoritative post-advance state comes from the row, never the local
    // object — a lost CAS race here means the run already moved on.
    const row = await this.runs.getRunRow(run.id) as Record<string, string | null>
    if (!row || Number(row.archived) !== 0) return { ok: false, error: 'RUN_CHANGED' }
    const live = row.execution_mode === 'agentcore'
    if (live && !dispatcher?.isEnabled()) return { ok: false, error: 'AGENT_DISPATCH_UNAVAILABLE' }
    const runState = row.state!
    const prior = row.decision_json ? JSON.parse(row.decision_json) as StoredDecision : null
    const rowInvocationB = row.invocation_b

    // Idempotent recovery, matched strictly: only the SAME submission (key +
    // choice) may return committed success. A different decision arriving
    // after one was recorded is a conflict — the first decision was consumed.
    // Exception: a resuming live run whose agent-resume dispatch artifact
    // records a runtime-CONFIRMED completion. The prior attempt died between
    // remote confirmation and local finalization (crash or local persistence
    // failure); the same submission falls through and repairs idempotently —
    // no redispatch, no new successor, deterministic builders only.
    const repairConfirmedResume = live && runState === 'resuming' && await this.hasConfirmedResume(run.id)
    if (live && runState === 'resuming' && !repairConfirmedResume) return { ok: false, error: 'AGENT_RESUME_IN_PROGRESS' }
    if (live && runState === 'blocked') return { ok: false, error: 'AGENT_RUN_BLOCKED' }
    if (runState !== 'decision_required' && !repairConfirmedResume) {
      if (prior && prior.choice === choice && prior.idempotencyKey === (idempotencyKey ?? null)) {
        return { ok: true, duplicate: true }
      }
      if (prior) return { ok: false, error: 'DECISION_ALREADY_RECORDED' }
      return { ok: false, error: `WRONG_STATE:${run.state}` }
    }
    const s = scopeScenario(patchScenario, run.id)
    if (!s.decision_request.options.includes(choice)) return { ok: false, error: 'INVALID_CHOICE' }
    if (rationale.trim().length === 0) return { ok: false, error: 'RATIONALE_REQUIRED' }
    // Idempotent reuse matches BOTH key and choice; a different key is a
    // different submission, not a retry (review finding 3).
    if (prior && (prior.choice !== choice || prior.idempotencyKey !== (idempotencyKey ?? null))) {
      return { ok: false, error: 'DECISION_ALREADY_RECORDED' }
    }

    // Atomically acquire the decision intent (choice, rationale, decidedAt,
    // successor id) BEFORE claiming. First writer wins; a concurrent loser
    // receives the STORED intent, so it can never claim with its own stale
    // successor (review findings 1+2). A crash between claim and state-write
    // leaves a retry that reuses the same successor and digest → 'replayed',
    // never a competing successor.
    const invocationB = rowInvocationB ?? `inv-${randomUUID()}`
    const decidedAt = prior?.decidedAt ?? new Date().toISOString()
    const stored = await this.runs.acquireDecisionIntent(
      run.id,
      invocationB,
      JSON.stringify({ choice: prior?.choice ?? choice, rationale: prior?.rationale ?? rationale, decidedAt, idempotencyKey: idempotencyKey ?? null, channel: prior ? prior.channel : channel }),
    )
    if (!stored.decision_json) return { ok: false, error: 'RUN_CHANGED' }
    const storedDecision = JSON.parse(stored.decision_json) as StoredDecision
    if (storedDecision.choice !== choice || storedDecision.idempotencyKey !== (idempotencyKey ?? null)) {
      return { ok: false, error: 'DECISION_ALREADY_RECORDED' }
    }
    // EVERY stored value is authoritative — including decidedAt, which is
    // part of the decision digest: a loser using its own timestamp would
    // claim with a mismatched digest (review P1).
    const effectiveChoice = storedDecision.choice
    const effectiveRationale = storedDecision.rationale
    const authoritativeDecidedAt = storedDecision.decidedAt
    const authoritativeInvocationB = stored.invocation_b ?? invocationB

    const decisionId = `decision-${run.id}`
    const decisionRecord = await this.decisionRecord(run.id, decisionId, effectiveChoice, effectiveRationale, authoritativeDecidedAt)

    const claim = await this.receipts.claim(decisionRecord, authoritativeInvocationB, decisionDigest(decisionRecord))
    if (claim.status === 'rejected') {
      // A terminal claim rejection is unrecoverable for this run: its
      // recorded decision can never be consumed (a receipt already exists
      // with a conflicting successor or digest). Park it as blocked so reset
      // can archive the run while the intent and dispatch evidence stay
      // queryable — a retained decision intent must never wedge
      // DECISION_IN_PROGRESS forever (review finding).
      await this.runs.updateRunPhase(run.id, 'decision_required', 'blocked', new Date().toISOString())
      return { ok: false, error: `CLAIM_REJECTED:${claim.reason}` }
    }

    const runtimeDecision = {
      decisionId: decisionRecord.decisionId,
      choice: effectiveChoice,
      rationale: effectiveRationale,
      decidedAt: authoritativeDecidedAt,
    }
    // Attribution belongs to the winning durable intent, just like its
    // choice and rationale. A retry may arrive under a different session.
    const decisionChannel = storedDecision.channel
    const humanDecision = buildHumanDecision(s, runtimeDecision, await this.evidenceDigest(run.id), decisionChannel
      ? { channel: { interaction: 'web_ui', ...decisionChannel } }
      : undefined)
    assertValid('human-decision', humanDecision)
    await this.storeArtifact(run.id, 'human-decision', 'human-decision', humanDecision)
    await this.storeArtifact(run.id, 'consumption-receipt', 'consumption-receipt', claim.receipt)

    if (live) {
      // Reserve dispatch durably. An in-flight or uncertain attempt is never
      // automatically repeated, even when a duplicate HTTP request arrives.
      // A repair (confirmed resume artifact already on disk) skips the
      // dispatch entirely — the runtime already completed this resume.
      let dispatchConfirmed = repairConfirmedResume
      if (!dispatchConfirmed && await this.runs.updateRunPhase(run.id, 'decision_required', 'resuming', new Date().toISOString())) {
        this.inflightResumes.add(run.id)
        try {
          const dispatched = await dispatcher!.dispatch({ kind: 'decision-resume', sessionId: run.id, choice: effectiveChoice, rationale: effectiveRationale })
          const response = dispatched.result?.result as Record<string, unknown> | undefined
          const effect = response?.effect as Record<string, unknown> | undefined
          const authorizedBy = effect?.authorizedBy as Record<string, unknown> | undefined
          // The completion must prove it executed the APPROVED action: the
          // returned effect matches the choice, stays a dry-run with no
          // external mutation, and its authorization references this
          // decision, the reported successor, and the reported receipt —
          // the same predicate the live gate asserts. A runtime reporting
          // a foreign or unsafe effect is a typed rejection; the console
          // never synthesizes a local effect over it (review P1).
          if (!dispatched.ok || response?.status !== 'COMPLETED' || response.decisionId !== `decision-svc-${run.id}` || typeof response.receiptId !== 'string' || typeof response.invocationB !== 'string'
            || effect?.effect !== effectiveChoice || effect.mode !== 'dry-run' || effect.noExternalMutationPerformed !== true
            || authorizedBy?.decisionId !== response.decisionId || authorizedBy?.successorInvocationId !== response.invocationB || authorizedBy?.consumptionReceiptId !== response.receiptId) {
            await this.storeDispatch(run.id, 'agent-resume', { ...dispatched, ok: false, error: dispatched.error ?? 'AGENT_RESUME_NOT_CONFIRMED' })
            await this.runs.updateRunPhase(run.id, 'resuming', 'blocked', new Date().toISOString())
            return { ok: false, error: dispatched.error ?? `AGENT_RESUME_NOT_COMPLETED:${String(response?.status)}` }
          }
          await this.storeConfirmedResume(run.id, dispatched)
          dispatchConfirmed = true
        } finally {
          this.inflightResumes.delete(run.id)
        }
      }
      if (!dispatchConfirmed) {
        const latest = await this.runs.getRunRow(run.id)
        if (latest?.state === 'completed' && Number(latest.archived) === 0) {
          return { ok: true, duplicate: true }
        }
        return { ok: false, error: 'AGENT_RESUME_IN_PROGRESS' }
      }
    }

    const effect = this.buildEffect(s, effectiveChoice, runtimeDecision.decisionId, claim.receipt.receiptId, authoritativeInvocationB)
    await this.storeArtifact(run.id, 'effect-receipt', 'effect-receipt', effect)

    const report = buildAgentReport(s, runtimeDecision, claim.receipt.receiptId, claim.receipt.decisionDigest.replace('sha256:', ''), { simulatedWorkspace: true })
    assertValid('agent-report', report)
    await this.storeArtifact(run.id, 'agent-report', 'agent-report', report)

    // CAS finalization: a slower same-key duplicate must never drag an
    // already-finalized/completed run back to resuming. Losing the race is
    // idempotent success — the winner recorded identical artifacts (the
    // builders are deterministic) from the same claim.
    const finalized = await this.runs.finalizeDecision(run.id, live ? 'resuming' : 'decision_required', live ? 'completed' : 'resuming', live ? new Date().toISOString() : authoritativeDecidedAt, JSON.stringify(claim.receipt), JSON.stringify(effect))
    if (!finalized) {
      const latest = await this.runs.getRunRow(run.id)
      if (!latest || Number(latest.archived) !== 0 || !['resuming', 'completed'].includes(latest.state ?? '')) return { ok: false, error: 'RUN_CHANGED' }
    }
    return { ok: true }
  }

  private async storeDispatch(runId: string, name: string, result: AgentDispatchResult): Promise<void> {
    await this.runs.storeArtifact({ runId, tenantId: this.tenant, name, kind: 'agent-dispatch', valid: result.ok, json: JSON.stringify(result) })
  }

  /** The confirmed resume envelope is the repair key for crashed
   * pre-finalization attempts, so its persistence gets a small bounded
   * retry: a single transient write failure must not orphan a remotely
   * completed resume (review P1). A sustained outage still fails loudly —
   * and a resuming run with no confirmed artifact remains resettable. */
  private async storeConfirmedResume(runId: string, result: AgentDispatchResult): Promise<void> {
    let lastError: unknown
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.storeDispatch(runId, 'agent-resume', result)
        return
      } catch (error) {
        lastError = error
        await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)))
      }
    }
    throw lastError
  }

  /** True when the durable agent-resume dispatch artifact records a
   * runtime-confirmed COMPLETED resume bound to this run — the evidence
   * that a crashed pre-finalization attempt may be repaired by rebuilding
   * the local spine without redispatching. */
  private async hasConfirmedResume(runId: string): Promise<boolean> {
    const stored = await this.runs.getArtifactJson(runId, 'agent-resume')
    if (stored === undefined) return false
    try {
      const dispatch = JSON.parse(stored) as { ok?: unknown, result?: { result?: { status?: unknown, decisionId?: unknown } } }
      return dispatch.ok === true
        && dispatch.result?.result?.status === 'COMPLETED'
        && dispatch.result.result.decisionId === `decision-svc-${runId}`
    } catch {
      return false
    }
  }

  async dispatchStart(runId: string, dispatcher: AgentDispatcher): Promise<{ ok: boolean, error?: string }> {
    await this.ready
    const row = await this.runs.getRunRow(runId)
    if (!row || row.tenant_id !== this.tenant || Number(row.archived) !== 0) return { ok: false, error: 'RUN_CHANGED' }
    if (row.execution_mode !== 'agentcore') return { ok: true }
    if (!dispatcher.isEnabled()) return { ok: false, error: 'AGENT_DISPATCH_UNAVAILABLE' }
    if (!(await this.runs.updateRunPhase(runId, 'running', 'starting', new Date().toISOString()))) {
      // Another start may have reserved or finished phase A since our read.
      // Accept that shared run without redispatching; a failed or archived
      // run still reports its stop instead of claiming an accepted start.
      const latest = await this.runs.getRunRow(runId)
      if (!latest || latest.tenant_id !== this.tenant || Number(latest.archived) !== 0) return { ok: false, error: 'RUN_CHANGED' }
      return ['starting', 'decision_required', 'resuming', 'completed'].includes(latest.state ?? '')
        ? { ok: true }
        : { ok: false, error: 'AGENT_START_IN_PROGRESS_OR_STOPPED' }
    }
    const dispatched = await dispatcher.dispatch({ kind: 'decision-run', sessionId: runId })
    const response = dispatched.result?.result as Record<string, unknown> | undefined
    const request = response?.decisionRequest as { patchId?: string, question?: string, options?: string[] } | undefined
    // The phase-A response must be bound to THIS run before the human gate
    // opens: the fixture matching alone would accept a stale or malformed
    // response carrying the same fixture (review P2).
    const accepted = dispatched.ok && response?.status === 'DECISION_REQUIRED'
      && response.decisionId === `decision-svc-${runId}`
      && typeof response.invocationA === 'string' && response.invocationA.length > 0
      && request?.patchId === `${patchScenario.package}-${patchScenario.to_version}`
      && request?.question === patchScenario.decision_request.question
      && JSON.stringify(request?.options) === JSON.stringify(patchScenario.decision_request.options)
    await this.storeDispatch(runId, 'agent-start', { ...dispatched, ok: Boolean(accepted), error: accepted ? undefined : dispatched.error ?? 'AGENT_DECISION_REQUEST_NOT_CONFIRMED' })
    const changed = await this.runs.updateRunPhase(runId, 'starting', accepted ? 'decision_required' : 'blocked', new Date().toISOString())
    if (!changed) return { ok: false, error: 'RUN_CHANGED' }
    return accepted ? { ok: true } : { ok: false, error: dispatched.error ?? 'AGENT_DECISION_REQUEST_NOT_CONFIRMED' }
  }

  /** The effect receipt executes ONLY the approved branch — the console's
   * core promise. Non-approval choices never produce a draft-PR payload. */
  private buildEffect(s: Scenario, choice: string, decisionId: string, consumptionReceiptId: string, invocationB: string): Record<string, unknown> {
    const base = {
      schema: 'who-decides.effect-receipt.v0',
      effect: choice,
      mode: 'dry-run',
      noExternalMutationPerformed: true,
      authorizedBy: { decisionId, consumptionReceiptId, successorInvocationId: invocationB },
    }
    if (choice === 'create_draft_pr') {
      return {
        ...base,
        exactPayload: {
          repo: 'example/kestrel-app',
          title: `Security: ${s.package} ${s.to_version}`,
          body: `${s.advisory}\n\nRuntime floor moves ${s.tradeoff.from} → ${s.tradeoff.to}. ${s.tradeoff.who_is_affected}.`,
          branch: `security/${s.package}-${s.to_version}`,
        },
      }
    }
    if (choice === 'send_back') {
      return {
        ...base,
        exactPayload: {
          outcome: 'no PR created — work returned to the agent',
          feedbackToAgent: `Resolve the runtime-floor question (${s.tradeoff.from} → ${s.tradeoff.to}) and resubmit for decision.`,
          queue: `revision/security-${s.package}-${s.to_version}`,
        },
      }
    }
    return {
      ...base,
      exactPayload: {
        outcome: 'nothing executed — decision deferred',
        revisitOn: 'next operator session',
      },
    }
  }

  async attemptDuplicateReplay(): Promise<{ attemptedBy: string, result: string, detail: string }> {
    const run = await this.currentRun()
    if (!run) throw new Error('NO_RUN')
    const row = await this.runs.getRunRow(run.id)
    const decisionJson = row?.decision_json ?? null
    const receiptJson = row?.receipt_json ?? null
    if (!decisionJson || !receiptJson) throw new Error('NOT_RESUMED_YET')
    const decision = JSON.parse(decisionJson) as { choice: string, rationale: string, decidedAt: string }
    const receipt = JSON.parse(receiptJson) as { decisionId: string }
    const record = await this.decisionRecord(run.id, receipt.decisionId, decision.choice, decision.rationale, decision.decidedAt)
    const imposter = `inv-${randomUUID()}`
    const result = await this.receipts.claim(record, imposter)
    const probe = result.status === 'rejected'
      ? { attemptedBy: imposter, result: `REJECTED (${result.reason})`, detail: result.detail }
      : { attemptedBy: imposter, result: 'CLAIMED — INVARIANT BROKEN', detail: 'consume-once failed!' }
    await this.runs.persistReplayProbe(run.id, JSON.stringify(probe))
    return probe
  }

  /** Real digest (raw hex; the builder adds the sha256: prefix) of the
   * invocation-A evidence the decision responds to — never a placeholder. */
  private async evidenceDigest(runId: string): Promise<string> {
    const json = await this.runs.getArtifactJson(runId, 'stop-response')
    if (json === undefined) throw new Error('EVIDENCE_MISSING:stop-response')
    return createHash('sha256').update(json).digest('hex')
  }

  private async decisionRecord(runId: string, decisionId: string, choice: string, rationale: string, decidedAt: string): Promise<DecisionRecord> {
    const stop = JSON.parse((await this.runs.getArtifactJson(runId, 'stop-response')) ?? 'null')
    if (typeof stop?.stop_id !== 'string') throw new Error('EVIDENCE_MISSING:stop-response')
    return {
      decisionId,
      chosenOption: choice,
      rationale,
      decidedAt,
      decisionRequestId: stop.stop_id,
      permittedAction: 'dry-run receipt for the approved branch (no external mutation)',
    }
  }

  /** Reset clears the live console without destroying completed audit
   * records — HACP artifacts survive the demo loop (Codex P2). Only THIS
   * tenant's console is cleared; other tenants' runs are untouched. */
  async reset(): Promise<void> {
    await this.ready
    // In-flight resumes are protected in memory: their confirmation
    // artifact does not exist yet, and the durable artifact rule below
    // must not let a concurrent reset archive a live dispatch.
    if (this.inflightResumes.size > 0) throw new Error('DECISION_IN_PROGRESS')
    await this.runs.archiveTenantRuns(this.tenant)
  }

  async close(): Promise<void> {
    // Initialization may fail after opening a pool, and either store's
    // close can reject. Attempt both cleanups while preserving the original
    // initialization/close error for the caller.
    const initialized = await Promise.allSettled([this.ready])
    const closed = await Promise.allSettled([
      Promise.resolve().then(() => this.receipts.close()),
      Promise.resolve().then(() => this.runs.close()),
    ])
    const failure = [...initialized, ...closed].find(result => result.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
  }

  private async storeArtifact(runId: string, name: string, kind: ArtifactKind | 'consumption-receipt' | 'effect-receipt', artifact: unknown): Promise<void> {
    const valid = kind === 'consumption-receipt' || kind === 'effect-receipt'
      ? validateReceipt(kind, artifact)
      : validateArtifact(kind, artifact).valid
    if (!valid) throw new Error(`ARTIFACT_INVALID:${kind}:${name}`)
    await this.runs.storeArtifact({
      runId, tenantId: this.tenant, name, kind,
      valid, json: JSON.stringify(artifact),
    })
  }

  async getState(): Promise<ConsoleState> {
    const run = await this.currentRun()
    if (!run) {
      return {
        schema: 'who-decides.console-state.v1',
        tenantId: this.tenant, executionMode: 'deterministic', agent: null,
        runId: '', state: 'ready', invocationA: null, invocationB: null,
        startedAt: null, completedAt: null, milestones: [], decisionRequest: null,
        decision: null, consumption: null, replayProbe: null, effect: null,
        artifacts: [], ...HEADING.ready,
      }
    }
    await this.advancePhases(run)
    const row = await this.runs.getRunRow(run.id) as Record<string, string | null>
    const s = scopeScenario(patchScenario, run.id)
    const artifacts = (await this.runs.listArtifacts(run.id, this.tenant))
      .map(a => ({ name: a.name, kind: a.kind as ArtifactKind, valid: a.valid === 1 }))
    const storedDecision = row.decision_json ? JSON.parse(row.decision_json) as StoredDecision : null
    const decision = storedDecision
      ? { choice: storedDecision.choice, rationale: storedDecision.rationale, decidedAt: storedDecision.decidedAt }
      : null
    const receipt = row.receipt_json ? JSON.parse(row.receipt_json) as { receiptId: string, decisionDigest: string, successorInvocationId: string, claimedAt: string } : null
    const effect = row.effect_json ? JSON.parse(row.effect_json) as ConsoleState['effect'] : null
    const replay = row.replay_json ? JSON.parse(row.replay_json) as ConsoleState['replayProbe'] : null
    // A run still provisioning renders as running — same console semantics;
    // provisioning is an internal lifecycle state, not a console state.
    const rawState = row.state ?? run.state
    const state = (['provisioning', 'starting'].includes(rawState) ? 'running' : rawState) as ConsoleState['state']
    return {
      schema: 'who-decides.console-state.v1',
      tenantId: this.tenant,
      executionMode: row.execution_mode ?? 'deterministic',
      agent: JSON.parse((await this.runs.getArtifactJson(run.id, 'agent-resume')) ?? (await this.runs.getArtifactJson(run.id, 'agent-start')) ?? 'null'),
      runId: run.id,
      state,
      invocationA: row.invocation_a,
      invocationB: row.invocation_b,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      milestones: row.milestones_json ? JSON.parse(row.milestones_json) as Milestone[] : [],
      decisionRequest: state === 'decision_required' || state === 'resuming' || state === 'completed'
        ? {
            question: s.decision_request.question,
            options: s.decision_request.options,
            humanTerms: s.decision_request.human_terms,
            whoIsAffected: s.tradeoff.who_is_affected,
            tradeoffFindingId: s.finding_tradeoff_id,
          }
        : null,
      decision,
      consumption: receipt
        ? { receiptId: receipt.receiptId, decisionDigest: receipt.decisionDigest, successorInvocationId: receipt.successorInvocationId, claimedAt: receipt.claimedAt }
        : null,
      replayProbe: replay,
      effect,
      artifacts,
      ...HEADING[state],
    }
  }
}

const engine = new ConsoleEngine()
export default engine
