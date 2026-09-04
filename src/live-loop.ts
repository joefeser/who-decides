/* One real-model end-to-end pass: a live Strands agent (Bedrock) drives
 * invocation A to a HUMAN_DECISION_REQUIRED interrupt, a scripted human
 * decision resumes it as invocation B, and every step lands on the typed
 * artifact spine (HACP v0.1-draft validated) with consume-once enforcement.
 *
 * Honesty clauses (same as the console):
 * - The "prepared patch" is the fixture scenario; the agent reasons over it,
 *   it does not edit a real repo.
 * - The effect is a dry-run receipt; no external mutation is performed.
 * - The claim is atomic and single-use; a duplicate successor is probed live.
 *
 * Run: WD_PROVIDER=bedrock AWS_PROFILE=who-decides npm run live-loop
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync, openSync, writeSync, closeSync, renameSync, fsyncSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Agent, FunctionTool, InterruptResponseContent } from '@strands-agents/sdk'
import type { AgentResult, Interrupt } from '@strands-agents/sdk'
import { loadProvider } from './provider'
import {
  buildTaskPacket, buildReviewFindings, buildStopResponse, buildHumanDecision,
  buildAgentReport,
} from './artifacts/build'
import type { Scenario } from './artifacts/build'
import { assertValid } from './artifacts/schemas'
import { ConsumptionStore, decisionDigest } from './consumption/store'
import type { DecisionRecord } from './consumption/store'
import { randomUUID, createHash } from 'node:crypto'

const RUN_TAG = process.env.WD_LIVE_TAG ?? new Date().toISOString().replace(/[:.]/g, '-')
/* Artifacts go to a per-tag directory; nothing is deleted on start. */
const RUN_DIR = path.resolve(process.cwd(), '.tmp/live-run', RUN_TAG)
/* The claim database lives OUTSIDE the per-run artifact directory: claims
 * must survive reruns so a reused WD_LIVE_TAG cannot re-claim its decision. */
const CLAIM_DB = path.resolve(process.cwd(), '.tmp/live-loop/consumption.db')
/* Decision state and session snapshot retained for inspection after a crash.
 * No automatic retry is authorized by their presence. */
const STATE_DIR = path.resolve(process.cwd(), '.tmp/live-loop')
const STATE_FILE = path.join(STATE_DIR, `state-${RUN_TAG}.json`)
const SNAPSHOT_FILE = path.join(STATE_DIR, `snapshot-${RUN_TAG}.json`)
/* Permanent per-tag reservation, acquired before any shared run writes.
 * Existing reservations (including dead/incomplete holders) fail closed.
 * PID death and receipt replay never establish safe reexecution. */
const LEASE_FILE = path.join(STATE_DIR, `lease-${RUN_TAG}.json`)

function reserveRun(): boolean {
  let fd: number
  try { fd = openSync(LEASE_FILE, 'wx') } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw err
  }
  try { writeSync(fd, JSON.stringify({ holderPid: process.pid, acquiredAt: new Date().toISOString() })) }
  finally { closeSync(fd) }
  return true
}

type RunState = {
  phase: 'claimed' | 'completed' | 'rejected'
  decisionId: string
  choice: string
  rationale: string
  decidedAt: string
  invocationA: string
  invocationB: string
  receiptId?: string
  outcome?: string
}

function loadState(): RunState | null {
  if (!existsSync(STATE_FILE)) return null
  return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as RunState
}

/** Durable atomic write: temp file + fsync + rename + directory fsync, so
 * neither a process crash nor power loss can leave the audit state
 * truncated, empty, or missing its directory entry (review P2). */
function saveState(state: RunState): void {
  const tmp = `${STATE_FILE}.tmp-${process.pid}`
  const fd = openSync(tmp, 'w')
  try {
    writeSync(fd, JSON.stringify(state, null, 2))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, STATE_FILE)
  syncDir(path.dirname(STATE_FILE))
}

/** Default rationale per choice — an approval argument must never be recorded
 * against a send_back/defer decision. WD_LIVE_RATIONALE overrides. */
const RATIONALE: Record<string, string> = {
  create_draft_pr: 'Security risk outweighs the runtime-floor bump; node 20 is our target platform.',
  send_back: 'The runtime-floor bump needs an answer for node 18 consumers before we ship this; resolve that and resubmit.',
  defer: 'Not now — revisit at the next planning session; nothing should execute meanwhile.',
}

function loadFixture(): Scenario {
  return JSON.parse(
    readFileSync(path.resolve(process.cwd(), 'fixtures/patch-scenario.json'), 'utf8'),
  ) as Scenario
}

function decisionTool(f: Scenario): FunctionTool {
  return new FunctionTool({
    name: 'request_release_decision',
    description: 'Ask the human whether to release the prepared security patch. Call exactly once when preparation is complete and verified.',
    inputSchema: {
      type: 'object',
      properties: { patchId: { type: 'string', description: 'the patch being held for decision' } },
      required: ['patchId'],
    },
    callback(input: unknown, context: { interrupt<T>(params: { name: string, reason?: unknown }): T }) {
      const patchId = (input as { patchId: string }).patchId
      const decision = context.interrupt<{ choice: string, rationale: string }>({
        name: 'human_release_decision',
        reason: {
          question: f.decision_request.question,
          patchId,
          tradeoff: `tests green, build green, one runtime compatibility check unresolved (${f.tradeoff.from} → ${f.tradeoff.to})`,
          options: f.decision_request.options,
        },
      })
      return { status: 'decision_received', decision, note: 'proceeding with exactly the approved branch' }
    },
  })
}

function promptFor(f: Scenario): string {
  return [
    `You are the background agent for a dependency-security task. Scenario (simulated workspace — do not edit files):`,
    `Package ${f.package} ${f.from_version} → ${f.to_version} (${f.advisory}).`,
    `Verification already ran: ${f.checks.unit}; ${f.checks.build}; ${f.checks.audit}.`,
    `Known tradeoff: ${f.tradeoff.who_is_affected}. ${f.tradeoff.unresolved_check}.`,
    ``,
    `Steps: (1) state briefly that the patch is prepared and verified,`,
    `(2) call request_release_decision exactly once with patchId "${f.package}-${f.to_version}", then stop.`,
    `You must not create any PR or external effect yourself — the human decides.`,
  ].join('\n')
}

/** Durable artifact write: fsync each file so the completed marker can never
 * outlive the artifacts it summarizes (review P2). */
function writeJson(name: string, value: unknown): void {
  const fd = openSync(path.join(RUN_DIR, name), 'w')
  try {
    writeSync(fd, JSON.stringify(value, null, 2))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function syncDir(dir: string): void {
  const dirFd = openSync(dir, 'r')
  try {
    fsyncSync(dirFd)
  } finally {
    closeSync(dirFd)
  }
}

/** Durable directory creation: fsync the parent's entry too, so power loss
 * cannot discard the just-created directory and everything inside it. */
function mkdirDurable(dir: string): void {
  mkdirSync(dir, { recursive: true })
  syncDir(path.dirname(dir))
}

type LiveRuntime = {
  agent: Pick<Agent, 'invoke' | 'loadSnapshot' | 'takeSnapshot'>
  provenance: ReturnType<typeof loadProvider>['provenance']
}

export async function main(runtimeFactory: (fixture: Scenario) => LiveRuntime = (fixture) => {
  const { model, provenance } = loadProvider()
  return { agent: new Agent({ model, tools: [decisionTool(fixture)] }), provenance }
}): Promise<void> {
  const started = Date.now()
  const f = loadFixture()

  // Validate the scripted decision BEFORE any model call or claim (fail fast).
  const HUMAN_CHOICE = process.env.WD_LIVE_CHOICE ?? 'create_draft_pr'
  if (!f.decision_request.options.includes(HUMAN_CHOICE)) {
    throw new Error(`INVALID_CHOICE:${HUMAN_CHOICE} — fixture options: ${f.decision_request.options.join(', ')}`)
  }
  // The tag becomes a path segment everywhere below — it must be a safe slug.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(RUN_TAG)) {
    throw new Error(`INVALID_TAG: WD_LIVE_TAG must be a filename-safe slug (letters, digits, . _ -; max 64 chars): "${RUN_TAG.slice(0, 24)}"`)
  }
  const HUMAN_RATIONALE = process.env.WD_LIVE_RATIONALE ?? RATIONALE[HUMAN_CHOICE]!
  if (HUMAN_RATIONALE.trim().length === 0) {
    throw new Error('RATIONALE_REQUIRED: WD_LIVE_RATIONALE must be a non-empty human rationale')
  }


  // ── Rerun of a previous tagged run? Stop without mutating its records. ─
  const prior = loadState()
  if (prior && prior.phase === 'completed') {
    console.log(`[stop] RUN_ALREADY_COMPLETED: decision ${prior.decisionId} was claimed by ${prior.invocationB} (receipt ${prior.receiptId}); the approved branch already executed.`)
    console.log('[stop] start a new run with a fresh WD_LIVE_TAG for a new decision.')
    return
  }
  if (prior && prior.phase === 'rejected') {
    console.log(`[stop] RUN_PREVIOUSLY_REJECTED: ${prior.outcome}`)
    return
  }
  if (prior && (prior.choice !== HUMAN_CHOICE || prior.rationale !== HUMAN_RATIONALE)) {
    throw new Error(`STATE_CONFLICT: tag ${RUN_TAG} already holds a ${prior.phase} decision (${prior.choice}); rerun with the same decision inputs or a fresh tag`)
  }

  // Incomplete historical state cannot prove whether B already started.
  // Retain it for inspection; never rerun A or B automatically.
  if (prior || existsSync(SNAPSHOT_FILE)) {
    console.log('[stop] HUMAN_DECISION_REQUIRED: prior run has an unknown execution outcome; automatic recovery is disabled.')
    return
  }
  mkdirDurable(STATE_DIR)
  if (!reserveRun()) {
    console.log('[stop] HUMAN_DECISION_REQUIRED: tag is already reserved; holder death does not authorize takeover.')
    return
  }
  mkdirDurable(RUN_DIR)
  const { agent, provenance } = runtimeFactory(f)
  console.log(`[live-loop] provider=${provenance.provider} model=${provenance.modelId} tag=${RUN_TAG}`)
  console.log(`[human] choice=${HUMAN_CHOICE} (scripted); rationale="${HUMAN_RATIONALE.slice(0, 60)}…"`)

  // ── Invocation A: real model, real interrupt ────────────────────────────
  let interruptId: string
  let invocationA: string
  {
    invocationA = `inv-${randomUUID()}`
    const first = await agent.invoke(promptFor(f))
    const interrupts: Interrupt[] = first.interrupts ?? []
    console.log(`[invocation A] ${invocationA} stopReason=${first.stopReason} interrupts=${interrupts.length}`)
    if (interrupts.length !== 1 || first.stopReason !== 'interrupt') {
      throw new Error(`INVARIANT: expected exactly one interrupt stop, got stopReason=${first.stopReason}, interrupts=${interrupts.length}`)
    }

    // The interrupt must be the scenario's decision request — the model called
    // OUR tool, and the model-provided patchId must match the fixture patch.
    const expectedPatchId = `${f.package}-${f.to_version}`
    const reason = interrupts[0]!.reason as { question?: string, patchId?: string, options?: string[] }
    if (interrupts[0]!.name !== 'human_release_decision'
      || reason?.question !== f.decision_request.question
      || reason?.patchId !== expectedPatchId
      || JSON.stringify(reason?.options) !== JSON.stringify(f.decision_request.options)) {
      throw new Error(`INVARIANT: interrupt does not match the scenario (name=${interrupts[0]!.name}, patchId=${reason?.patchId}, expected ${expectedPatchId})`)
    }
    console.log(`[invocation A] interrupt verified: human_release_decision for ${expectedPatchId}`)
    interruptId = interrupts[0]!.id

    // Persist the resumable session BEFORE claiming (Codex P2: the successor
    // identity and resumable state must survive a crash after the claim).
    writeFileSync(SNAPSHOT_FILE, JSON.stringify(agent.takeSnapshot({ preset: 'session' })))
  }

  // ── The spine records what actually happened (validated) ────────────────
  const packet = buildTaskPacket(f)
  assertValid('task-packet', packet)
  const findings = buildReviewFindings(f)
  for (const finding of findings) assertValid('review-finding', finding)
  const stop = buildStopResponse(f)
  assertValid('stop-response', stop)
  writeJson('01-task-packet.json', packet)
  writeJson('02-review-findings.json', findings)
  writeJson('03-stop-response.json', stop)
  console.log('[spine] packet + 2 findings + stop-response validated')

  // ── Claim BEFORE resume: the claim gates execution (Codex P1 / Qodo 1). ─
  // Persist decision intent and successor for audit before taking the claim.
  // Incomplete state is inspection evidence, not automatic retry authority.
  const state: RunState = {
    phase: 'claimed',
    decisionId: `decision-live-${RUN_TAG}`,
    choice: HUMAN_CHOICE,
    rationale: HUMAN_RATIONALE,
    decidedAt: new Date().toISOString(),
    invocationA,
    invocationB: `inv-${randomUUID()}`,
  }
  saveState(state)
  const decisionRecord: DecisionRecord = {
    decisionId: state.decisionId,
    chosenOption: state.choice,
    rationale: state.rationale,
    decidedAt: state.decidedAt,
    decisionRequestId: f.stop_id,
    permittedAction: 'dry-run receipt for the approved branch (no external mutation)',
  }
  const store = new ConsumptionStore(CLAIM_DB)
  const claim = store.claim(decisionRecord, state.invocationB, decisionDigest(decisionRecord))
  if (claim.status === 'rejected') {
    store.close()
    const outcome = `DECISION_ALREADY_CLAIMED:${claim.reason} — ${claim.detail}`
    saveState({ ...state, phase: 'rejected', outcome })
    writeJson('00-live-run-summary.json', {
      tag: RUN_TAG, provider: provenance, invocationA,
      outcome, decisionId: state.decisionId, durationMs: Date.now() - started,
    })
    console.log(`[stop] ${outcome}`)
    console.log('[stop] invocation B NOT started — the decision was already consumed; the approved branch never executed.')
    return
  }
  if (claim.status === 'replayed') {
    store.close()
    console.log('[stop] HUMAN_DECISION_REQUIRED: existing claim does not authorize reexecution; invocation B not started.')
    return
  }
  console.log(`[consume-once] claim ${claim.status}; receipt ${claim.receipt.receiptId}`)

  // ── Invocation B: resume the REAL agent with exactly the approved branch ─
  const resumed: AgentResult = await agent.invoke([
    new InterruptResponseContent({
      interruptId,
      response: { choice: state.choice, rationale: state.rationale },
    }),
  ])
  const finalText = JSON.stringify(resumed.lastMessage?.content ?? [])
  console.log(`[invocation B] ${state.invocationB} stopReason=${resumed.stopReason}`)
  console.log(`[invocation B] final: ${finalText.slice(0, 300)}`)
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
  console.log('[consume-once] duplicate probe REJECTED (competing_successor)')

  const runtimeDecision = { decisionId: state.decisionId, choice: state.choice, rationale: state.rationale, decidedAt: state.decidedAt }
  // Digest the EXACT bytes written to 03-stop-response.json (writeJson uses
  // the same 2-space serialization), so consumers can verify the reference
  // against the saved artifact (review P2).
  const stopBytes = JSON.stringify(stop, null, 2)
  const evidenceDigest = createHash('sha256').update(stopBytes).digest('hex')
  // The decision channel here is a scripted CLI env flow, not a web session —
  // the artifact says so plainly (review P2).
  const humanDecision = buildHumanDecision(f, runtimeDecision, evidenceDigest, {
    channel: {
      interaction: 'cli',
      sessionReference: 'scripted-env:WD_LIVE_CHOICE+WD_LIVE_RATIONALE',
      authEventRef: 'demo-none',
    },
  })
  assertValid('human-decision', humanDecision)

  const effect = {
    schema: 'who-decides.effect-receipt.v0',
    effect: state.choice,
    mode: 'dry-run',
    // The payload is constructed by the host script from fixture data; the
    // model's returned text never feeds it. Authorization comes from the
    // recorded human decision and its consumption receipt (authorizedBy).
    exactPayload: state.choice === 'create_draft_pr'
      ? { repo: 'example/kestrel-app', title: `Security: ${f.package} ${f.to_version}`, branch: `security/${f.package}-${f.to_version}`, payloadSource: 'host-constructed from fixture (model output advisory only)' }
      : { outcome: state.choice === 'send_back' ? 'no PR created — work returned' : 'nothing executed — deferred', payloadSource: 'host-constructed from fixture (model output advisory only)' },
    noExternalMutationPerformed: true,
    authorizedBy: { decisionId: state.decisionId, consumptionReceiptId: claim.receipt.receiptId, successorInvocationId: state.invocationB },
  }
  const report = buildAgentReport(f, runtimeDecision, claim.receipt.receiptId, claim.receipt.decisionDigest.replace('sha256:', ''), { simulatedWorkspace: true })
  assertValid('agent-report', report)

  writeJson('04-human-decision.json', humanDecision)
  writeJson('05-consumption-receipt.json', claim.receipt)
  writeJson('06-effect-receipt.json', effect)
  writeJson('07-agent-report.json', report)
  writeJson('00-live-run-summary.json', {
    tag: RUN_TAG,
    provider: provenance,
    invocationA, invocationB: state.invocationB,
    interruptVerified: { question: true, patchId: `${f.package}-${f.to_version}`, options: true },
    recoveredFromCrash: false,
    humanChoice: state.choice,
    decisionId: state.decisionId,
    claimStatus: claim.status,
    receiptId: claim.receipt.receiptId,
    duplicateProbe: 'REJECTED (competing_successor)',
    durationMs: Date.now() - started,
  })
  // All artifacts are fsynced; flush the run directory entry too, so the
  // durable completed marker can never name artifacts that are missing.
  syncDir(RUN_DIR)
  saveState({ ...state, phase: 'completed', receiptId: claim.receipt.receiptId })

  console.log(`[done] ${((Date.now() - started) / 1000).toFixed(1)}s — artifacts in ${RUN_DIR}`)
  console.log(`[done] decision ${state.decisionId} claimed before execution and consumed exactly once by ${state.invocationB}; dry-run only; no external mutation.`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch((err) => {
  console.error('[live-loop] FAILED:', err instanceof Error ? err.message : err)
  process.exitCode = 1
})
