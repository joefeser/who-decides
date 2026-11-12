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
  buildAgentReport, scopeScenario, buildBridgeRecord,
} from '../artifacts/build'
import type { Scenario } from '../artifacts/build'
import { decisionDigest } from '../consumption/store'
import type { DecisionRecord } from '../consumption/store'
import { patchScenario } from '../agent-service/fixture'
import { parseDecisionRequest, validateBridgeArtifact } from '../bridge/schemas'
import type { BridgeArtifactKind, DecisionRequestEnvelope, BridgeIntakeRecord } from '../bridge/schemas'
import { Outbox, buildAnswerOp } from './outbox'
import type { OutboxDispatcher, OutboxOpOutcome } from './outbox'
import { chopinTransportFromEnv } from './chopin-transport'
import type { RunStore, NewOutboxOp } from './store/store'
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
  /** 'native' — fixture scenario | 'bridge' — external decision request. */
  runKind: 'native' | 'bridge'
  state: RunState | 'ready'
  invocationA: string | null
  invocationB: string | null
  startedAt: string | null
  completedAt: string | null
  milestones: Milestone[]
  decisionRequest: {
    question: string
    /** The operator chooses by ID; the label is what they read. Native
     * fixture runs have IDs only, so their label is the ID itself. */
    options: Array<{ id: string, label: string }>
    /** Native-run fixture fields. */
    humanTerms?: string
    whoIsAffected?: string
    tradeoffFindingId?: string
    /** Bridge-run fields (rendered from the persisted envelope). */
    sourceSystem?: string
    contextRefs?: string[]
  } | null
  decision: { choice: string, rationale: string, decidedAt: string } | null
  consumption: { receiptId: string, decisionDigest: string, successorInvocationId: string, claimedAt: string } | null
  replayProbe: { attemptedBy: string, result: string, detail: string } | null
  effect: { effect: string, mode: string, noExternalMutationPerformed: boolean, exactPayload: Record<string, unknown> } | null
  /** Bridge-run outbound ops (A2): empty for native runs. */
  outbox: Array<{ opKey: string, kind: string, targetSystem: string, status: string, result: unknown, dispatchedAt: string | null, resolvedAt: string | null }>
  artifacts: Array<{ name: string, kind: ArtifactKind | 'consumption-receipt' | 'effect-receipt' | 'agent-dispatch' | 'bridge-record' | BridgeArtifactKind, valid: boolean }>
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

/* Bridge records (A3) — a SEPARATE validator by design: bridge records are
 * explicitly not HACP artifacts and not the dry-run receipt family; the
 * dry-run validators above are untouched. Same no-free-green-check
 * discipline: a malformed record fails the write. Boundary fields (the
 * operation vocabulary, full sha256 digests, the approver-as-asserted
 * block) are enforced exactly. */
function validateBridgeRecord(artifact: unknown): boolean {
  if (typeof artifact !== 'object' || artifact === null) return false
  const r = artifact as Record<string, unknown>
  const approver = r.approverAsAssertedByBridge as Record<string, unknown> | undefined
  return r.schema === 'who-decides.bridge-record.v0'
    && typeof r.runId === 'string' && r.runId.length > 0
    && typeof r.targetSystem === 'string' && r.targetSystem.length > 0
    && (r.operation === 'answer' || r.operation === 'approve')
    && typeof r.idempotencyKey === 'string' && r.idempotencyKey.length > 0
    && /^sha256:[0-9a-f]{64}$/.test(r.payloadDigest as string)
    && /^sha256:[0-9a-f]{64}$/.test(r.resultDigest as string)
    && typeof r.choice === 'string' && r.choice.length > 0
    && approver?.assertedBy === 'who-decides'
    && typeof approver?.actor_id === 'string' && approver.actor_id.length > 0
    && approver?.actor_kind === 'human'
    && typeof approver?.session_reference === 'string' && approver.session_reference.length > 0
    && typeof approver?.auth_event_ref === 'string' && approver.auth_event_ref.length > 0
    && typeof r.recordedAt === 'string' && r.recordedAt.length > 0
}

export class ConsoleEngine {
  private readonly runs: RunStore
  private readonly receipts: ReceiptStore
  private readonly outbox: Outbox
  /** Optional bridge transport (A2): when wired, a recorded bridge decision
   * dispatches its outbound ops inline; without it, ops stay pending for an
   * explicit dispatchBridgeOps resume (tests, demo wiring, recovery). */
  private readonly bridgeDispatcher: OutboxDispatcher | undefined
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
  /** Fixed, sanitized reason the configured chopin target is broken. Absent
   * when no target was configured (an intentional unset) and when everything
   * is healthy — the console distinguishes "not configured" from "configured
   * wrong" without exposing token material. */
  readonly bridgeDispatchError: string | undefined

  constructor(tenant: string = process.env.WD_TENANT_ID ?? 'default', stores?: { runs?: RunStore, receipts?: ReceiptStore, bridgeDispatcher?: OutboxDispatcher }, bridgeDispatchError?: string) {
    this.tenant = tenant
    const dir = process.env.WD_CONSOLE_DIR ?? DB_DIR
    // Backend selection (WD_STORE=sqlite|postgres) lives in the factory;
    // the engine itself never branches on the storage backend. Each missing
    // store is defaulted independently, so partial injection never builds
    // an unused adapter that close() could not reach.
    this.runs = stores?.runs ?? createDefaultRunStore(dir)
    this.receipts = stores?.receipts ?? createDefaultReceiptStore(dir)
    this.outbox = new Outbox(this.runs)
    this.bridgeDispatcher = stores?.bridgeDispatcher
    this.bridgeDispatchError = bridgeDispatchError
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
      // A bridge run holds the tenant's single active slot: native
      // provisioning must never graft fixture artifacts onto it. The
      // operator resets (archives) the bridge run to return to native runs.
      if (active.run_kind === 'bridge') throw new Error('BRIDGE_RUN_ACTIVE')
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

  /** External intake for the bridge run kind (A1). Persists the exact
   * envelope under a NEW run created directly in decision_required — there
   * is no invocation A, no fixture scenario, and no native artifact spine.
   * The envelope is re-validated here even when the route already checked
   * it: engine callers (tests, future poll workers) get the same strict
   * guarantee at the boundary that persists it.
   *
   * The machine principal that authenticated the intake is recorded
   * alongside (from the auth result, never the envelope) with a digest of
   * the exact accepted envelope bytes. It delivered the request; the actor
   * is recorded later, at decision time, from the operator session channel.
   *
   * Single-active-run stays store-level: ensureActiveRun's atomic
   * check-and-insert either wins the slot or returns the existing active
   * run — and an external request can never merge into an existing run, so
   * a lost race is a typed refusal, not an idempotent join (native runs may
   * join; bridge intake may not). */
  async startBridgeRun(envelope: unknown, principal: { principal: string, credentialRef: string }): Promise<{ ok: true, runId: string } | { ok: false, error: string }> {
    await this.ready
    const parsed = parseDecisionRequest(envelope)
    if (!parsed.valid) return { ok: false, error: 'ENVELOPE_INVALID' }
    const env = parsed.envelope
    const runId = `run-${randomUUID()}`
    const now = new Date().toISOString()
    const milestones: Milestone[] = [
      { label: 'intake', detail: `decision request from ${env.sourceSystem} · ${env.options.length} options · ${env.digests.length} digests`, at: now },
    ]
    const active = await this.runs.ensureActiveRun(this.tenant, {
      id: runId, tenantId: this.tenant, invocationA: null, startedAt: now, phaseChangedAt: now,
      milestonesJson: JSON.stringify(milestones), runKind: 'bridge',
    })
    if (active.id !== runId) return { ok: false, error: 'ACTIVE_RUN_EXISTS' }
    try {
      await this.storeArtifact(runId, 'decision-request', 'decision-request', env)
      const requestDigest = `sha256:${createHash('sha256').update(JSON.stringify(env)).digest('hex')}`
      await this.storeArtifact(runId, 'bridge-intake', 'bridge-intake', {
        schema: 'who-decides.bridge-intake.v0',
        runId, principal: principal.principal, credentialRef: principal.credentialRef,
        receivedAt: now, requestDigest,
      } satisfies BridgeIntakeRecord)
      // The run IS a held decision request: it opens at the human gate, not
      // at a running phase. A crash mid-intake leaves a provisioning run
      // that reset can archive (no decision intent exists yet).
      if (!(await this.runs.updateRunPhase(runId, 'provisioning', 'decision_required', now))) {
        throw new Error(`PROVISIONING_RETRACTED:${runId}`)
      }
    } catch (err) {
      await this.runs.retractProvisioningRun(runId).catch(() => { /* best-effort cleanup */ })
      throw err
    }
    return { ok: true, runId }
  }

  /** Explicit outbox dispatch/resume for a bridge run (A2): drives every
   * unresolved op through the given transport — pending ops (intent
   * committed, dispatch never ran) dispatch for the first time;
   * dispatched/unknown ops (crash window, lost response) re-send the EXACT
   * persisted payload under the same op key. Terminal ops are echoed, never
   * re-dispatched. Repeat-safe by construction. Newly confirmed ops get
   * their bridge records (A3). */
  async dispatchBridgeOps(runId: string, dispatcher: OutboxDispatcher, options?: { force?: boolean }): Promise<{ ok: boolean, error?: string, outcomes?: OutboxOpOutcome[] }> {
    await this.ready
    const row = await this.runs.getRunRow(runId)
    if (!row || row.tenant_id !== this.tenant || Number(row.archived) !== 0) return { ok: false, error: 'RUN_CHANGED' }
    if (row.run_kind !== 'bridge') return { ok: false, error: 'NOT_A_BRIDGE_RUN' }
    const outcomes = await this.outbox.dispatch(runId, dispatcher, options)
    await this.recordConfirmedBridgeOps(runId)
    return { ok: true, outcomes }
  }

  /** Production resume (review round 1, P2): drives every unresolved op of a
   * bridge run through the CONFIGURED transport — after a timeout, after
   * correcting configuration for a pending op, or after a process crash.
   * Uses the existing outbox claim (one live wire attempt per op across
   * instances); a re-submitted identical decision still returns duplicate,
   * so this is the only path that retries dispatch. WITHOUT force, a claim
   * held by another (possibly dead) owner is respected — the outcome reads
   * in_progress and the op stays as it is. `force` is the runbook's
   * separate dead-owner recovery step, for use only after verifying the
   * owning process is gone. */
  async resumeBridgeOps(runId: string, options?: { force?: boolean }): Promise<{ ok: boolean, error?: string, outcomes?: OutboxOpOutcome[] }> {
    if (!this.bridgeDispatcher) {
      return { ok: false, error: this.bridgeDispatchError ?? 'BRIDGE_DISPATCHER_NOT_CONFIGURED' }
    }
    return this.dispatchBridgeOps(runId, this.bridgeDispatcher, options)
  }

  /** Writes the non-HACP bridge record (A3) for every CONFIRMED op that
   * does not have one yet — idempotent by artifact name (first-writer-wins)
   * and repeat-safe with dispatch. The record digests the EXACT persisted
   * payload and result bytes; the approver block is the decision's operator
   * session channel, labeled asserted-by-bridge. Only confirmed ops get
   * records: unknown stays unknown and failed retains its typed error in
   * the op row — a receipt never asserts what was not confirmed. */
  private async recordConfirmedBridgeOps(runId: string): Promise<void> {
    const env = await this.bridgeEnvelope(runId)
    const row = await this.runs.getRunRow(runId)
    const decision = row?.decision_json ? JSON.parse(row.decision_json) as StoredDecision : null
    for (const op of await this.outbox.ops(runId)) {
      if (op.status !== 'confirmed' || op.result_json === null) continue
      const name = `bridge-record:${op.op_key}`
      if (await this.runs.getArtifactJson(runId, name) !== undefined) continue
      const record = buildBridgeRecord({
        runId,
        targetSystem: op.target_system,
        operation: op.kind,
        idempotencyKey: op.op_key,
        payloadJson: op.payload_json,
        resultJson: op.result_json,
        choice: decision?.choice ?? '',
        envelopeOptionIds: env.options.map(o => o.id),
        channel: decision?.channel,
        recordedAt: new Date().toISOString(),
      })
      await this.storeArtifact(runId, name, 'bridge-record', record)
    }
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
   * local object only advances when the CAS won. Bridge runs never advance
   * on wall-clock: their phases move on recorded acts (intake, decision,
   * outbound dispatch), never on elapsed demo time. */
  private async advancePhases(run: { id: string, state: string, phase_changed_at: string, execution_mode?: string, run_kind?: string }): Promise<void> {
    if (run.execution_mode === 'agentcore' || run.run_kind === 'bridge') return
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
    // Bridge runs validate the choice against the PERSISTED INTAKE ENVELOPE,
    // never the fixture scenario — the fixture's option set (and its
    // validation at this very line for native runs) simply does not apply to
    // a run whose question arrived from outside.
    const isBridge = row.run_kind === 'bridge'
    const bridgeEnv = isBridge ? await this.bridgeEnvelope(run.id) : undefined
    if (isBridge) {
      if (!bridgeEnv!.options.some(o => o.id === choice)) return { ok: false, error: 'INVALID_CHOICE' }
    } else {
      const s = scopeScenario(patchScenario, run.id)
      if (!s.decision_request.options.includes(choice)) return { ok: false, error: 'INVALID_CHOICE' }
    }
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
    //
    // A2 (bridge): the outbound answer op commits in the SAME store
    // transaction — the one-transaction rule. Its payload is built here,
    // ONCE, from persisted state only (intake envelope coordination + the
    // choice being recorded); only the intent winner's op inserts.
    const answerOp: NewOutboxOp | undefined = isBridge
      ? buildAnswerOp(run.id, bridgeEnv!.coordination, choice, bridgeEnv!.sourceSystem)
      : undefined
    const invocationB = rowInvocationB ?? `inv-${randomUUID()}`
    const decidedAt = prior?.decidedAt ?? new Date().toISOString()
    const stored = await this.runs.acquireDecisionIntent(
      run.id,
      invocationB,
      JSON.stringify({ choice: prior?.choice ?? choice, rationale: prior?.rationale ?? rationale, decidedAt, idempotencyKey: idempotencyKey ?? null, channel: prior ? prior.channel : channel }),
      answerOp,
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

    if (isBridge) {
      // Bridge decision path: record the answer with operator-channel
      // attribution and hold the run at resuming — outbound dispatch is the
      // outbox's concern (A2); a bridge run NEVER completes on wall-clock.
      // There is no native spine here (no consumption claim, no effect
      // receipt, no agent report): the bridge run kind produces no
      // HACP-schema artifacts at all; its records are bridge schemas.
      const env = bridgeEnv!
      const intake = await this.bridgeIntake(run.id)
      const record = this.buildBridgeDecision(run.id, env, intake, {
        choice: effectiveChoice, rationale: effectiveRationale, decidedAt: authoritativeDecidedAt,
      }, storedDecision.channel)
      await this.storeArtifact(run.id, 'bridge-decision', 'bridge-decision', record)
      // CAS finalization mirrors the native path's discipline: a slower
      // same-key duplicate that loses the race is idempotent success.
      if (!(await this.runs.updateRunPhase(run.id, 'decision_required', 'resuming', new Date().toISOString()))) {
        const latest = await this.runs.getRunRow(run.id)
        if (!latest || Number(latest.archived) !== 0 || latest.state !== 'resuming') return { ok: false, error: 'RUN_CHANGED' }
      }
      // With a transport wired, the outbound op dispatches inline — exact
      // persisted payload only. A dispatcher exception must not unrecord the
      // decision: the op stays in its persisted state (dispatched/unknown)
      // and dispatchBridgeOps resumes it with the same bytes.
      if (this.bridgeDispatcher) {
        try {
          await this.outbox.dispatch(run.id, this.bridgeDispatcher)
          await this.recordConfirmedBridgeOps(run.id)
        } catch { /* transport threw — op state is the honest record; resume re-sends */ }
      }
      return { ok: true }
    }

    // Native path from here: the scenario is re-derived deterministically
    // (scopeScenario only tags IDs), identical to the validation read above.
    const s = scopeScenario(patchScenario, run.id)

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

  /** The persisted intake envelope for a bridge run — the authoritative
   * question and option set a bridge decision is validated against (never
   * the fixture). Re-validated on read: a tampered artifact fails loudly
   * instead of silently widening the decision surface. */
  private async bridgeEnvelope(runId: string): Promise<DecisionRequestEnvelope> {
    const json = await this.runs.getArtifactJson(runId, 'decision-request')
    if (json === undefined) throw new Error('EVIDENCE_MISSING:decision-request')
    const parsed = parseDecisionRequest(JSON.parse(json))
    if (!parsed.valid) throw new Error('EVIDENCE_INVALID:decision-request')
    return parsed.envelope
  }

  /** Console rendering of a bridge run's decision request — exactly what
   * the persisted envelope carries: the question, the option IDs the
   * operator may choose, and the source system's context refs. No fixture
   * fields are invented for a bridge run. */
  private async bridgeDecisionRequest(runId: string): Promise<NonNullable<ConsoleState['decisionRequest']>> {
    const env = await this.bridgeEnvelope(runId)
    return {
      question: env.question,
      options: env.options.map(o => ({ id: o.id, label: o.label ?? o.id })),
      sourceSystem: env.sourceSystem,
      contextRefs: env.contextRefs,
    }
  }

  /** The persisted intake record (machine principal + envelope digest) for
   * a bridge run. The principal recorded here is the AUTHENTICATED machine
   * channel that delivered the request — it is cited on the decision record
   * as intake context and is never conflated with the decision actor. */
  private async bridgeIntake(runId: string): Promise<BridgeIntakeRecord> {
    const json = await this.runs.getArtifactJson(runId, 'bridge-intake')
    if (json === undefined) throw new Error('EVIDENCE_MISSING:bridge-intake')
    const intake = JSON.parse(json) as BridgeIntakeRecord
    if (!validateBridgeArtifact('bridge-intake', intake)) throw new Error('EVIDENCE_INVALID:bridge-intake')
    return intake
  }

  /** Builds the Gate-1 answer record for a bridge run — explicitly NOT a
   * HACP artifact. Attribution extends build.ts's human-decision pattern:
   * the actor is the operator session channel that carried the answer
   * (passcode-session honesty preserved); with no channel, the same explicit
   * demo-unauthenticated defaults build.ts uses. The intake machine
   * principal is recorded beside the actor, clearly labeled as the delivery
   * channel. The envelope itself cannot carry identity — the schema has no
   * actor field and rejects extra properties. */
  private buildBridgeDecision(
    runId: string,
    env: DecisionRequestEnvelope,
    intake: BridgeIntakeRecord,
    d: { choice: string, rationale: string, decidedAt: string },
    channel?: DecisionChannel,
  ): Record<string, unknown> {
    const actor = {
      actor_id: channel ? channel.sessionReference : 'demo-unauthenticated-local-console',
      actor_kind: 'human',
      actor_verification_source: channel ? 'server_session_with_human_interaction' : 'unverified_demo',
      authentication_context: {
        interaction_channel: channel ? 'web_ui' : 'other',
        session_reference: channel?.sessionReference ?? 'demo-unauthenticated-local-console',
        auth_event_ref: channel?.authEventRef ?? 'demo-none',
        secret_material_present: false,
      },
    }
    return {
      schema: 'who-decides.bridge-decision.v0',
      runId,
      decisionId: `decision-${runId}`,
      sourceSystem: env.sourceSystem,
      question: env.question,
      choice: d.choice,
      rationale: d.rationale,
      decidedAt: d.decidedAt,
      actor,
      intakePrincipal: { principal: intake.principal, credentialRef: intake.credentialRef },
      evidence: {
        contextRefs: env.contextRefs,
        digests: env.digests,
        requestDigest: intake.requestDigest,
      },
    }
  }

  /** Reset clears the live console without destroying completed audit
   * records — HACP artifacts survive the demo loop (Codex P2). Only THIS
   * tenant's console is cleared; other tenants' runs are untouched. */
  /** The current run's persisted artifact JSON (watch-mode evidence surface).
   * Public by design: artifacts are the receipts the demo claims to show.
   * Returns the current run's id EVEN WHEN the named artifact is not (yet)
   * persisted — e.g. a still-running run has no human-decision yet — so
   * callers can distinguish "the run changed" from "evidence missing"
   * and never report absence for a run that is not being served (review). */
  async getArtifact(name: string): Promise<{ runId: string, json: string | undefined } | undefined> {
    await this.ready
    const run = await this.currentRun()
    if (!run) return undefined
    return { runId: run.id, json: await this.runs.getArtifactJson(run.id, name) }
  }

  async reset(): Promise<void> {
    await this.ready
    // In-flight resumes are protected in memory: their confirmation
    // artifact does not exist yet, and the durable artifact rule below
    // must not let a concurrent reset archive a live dispatch.
    if (this.inflightResumes.size > 0) throw new Error('DECISION_IN_PROGRESS')
    // The unresolved-bridge-operation guard rides the store's archive
    // transaction itself: a decision committing between a separate check
    // and the archive would strand its outbound obligation. The store
    // refuses BRIDGE_OPS_UNRESOLVED; the recoverable disposition is to
    // dispatch (or let it resolve) first, then reset.
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

  private async storeArtifact(runId: string, name: string, kind: ArtifactKind | 'consumption-receipt' | 'effect-receipt' | 'bridge-record' | BridgeArtifactKind, artifact: unknown): Promise<void> {
    const valid = kind === 'consumption-receipt' || kind === 'effect-receipt'
      ? validateReceipt(kind, artifact)
      : kind === 'bridge-record'
        ? validateBridgeRecord(artifact)
        : kind === 'decision-request' || kind === 'bridge-intake' || kind === 'bridge-decision'
          ? validateBridgeArtifact(kind, artifact)
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
        runId: '', runKind: 'native', state: 'ready', invocationA: null, invocationB: null,
        startedAt: null, completedAt: null, milestones: [], decisionRequest: null,
        decision: null, consumption: null, replayProbe: null, effect: null, outbox: [],
        artifacts: [], ...HEADING.ready,
      }
    }
    await this.advancePhases(run)
    const row = await this.runs.getRunRow(run.id) as Record<string, string | null>
    const runKind: 'native' | 'bridge' = row.run_kind === 'bridge' ? 'bridge' : 'native'
    const s = runKind === 'native' ? scopeScenario(patchScenario, run.id) : undefined
    const outbox = runKind === 'bridge' ? (await this.outbox.ops(run.id)).map(op => ({
      opKey: op.op_key, kind: op.kind, targetSystem: op.target_system, status: op.status,
      result: op.result_json === null ? null : JSON.parse(op.result_json),
      dispatchedAt: op.dispatched_at, resolvedAt: op.resolved_at,
    })) : []
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
      runKind,
      state,
      invocationA: row.invocation_a,
      invocationB: row.invocation_b,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      milestones: row.milestones_json ? JSON.parse(row.milestones_json) as Milestone[] : [],
      decisionRequest: state === 'decision_required' || state === 'resuming' || state === 'completed'
        ? runKind === 'bridge'
          ? await this.bridgeDecisionRequest(run.id)
          : {
              question: s!.decision_request.question,
              options: s!.decision_request.options.map((id: string) => ({ id, label: id })),
              humanTerms: s!.decision_request.human_terms,
              whoIsAffected: s!.tradeoff.who_is_affected,
              tradeoffFindingId: s!.finding_tradeoff_id,
            }
        : null,
      decision,
      consumption: receipt
        ? { receiptId: receipt.receiptId, decisionDigest: receipt.decisionDigest, successorInvocationId: receipt.successorInvocationId, claimedAt: receipt.claimedAt }
        : null,
      replayProbe: replay,
      effect,
      outbox,
      artifacts,
      ...HEADING[state],
    }
  }
}

const engine = (() => {
  const wiring = chopinTransportFromEnv()
  return new ConsoleEngine(undefined, wiring.dispatcher ? { bridgeDispatcher: wiring.dispatcher } : undefined, wiring.configError)
})()
export default engine
