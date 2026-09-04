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
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
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
import { readFileSync } from 'node:fs'

const RUN_TAG = process.env.WD_LIVE_TAG ?? new Date().toISOString().replace(/[:.]/g, '-')
/* Artifacts go to a per-tag directory; nothing is deleted on start. */
const RUN_DIR = path.resolve(process.cwd(), '.tmp/live-run', RUN_TAG)
/* The claim database lives OUTSIDE the per-run artifact directory: claims
 * must survive reruns so a reused WD_LIVE_TAG cannot re-claim its decision. */
const CLAIM_DB = path.resolve(process.cwd(), '.tmp/live-loop/consumption.db')

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

function writeJson(name: string, value: unknown): void {
  writeFileSync(path.join(RUN_DIR, name), JSON.stringify(value, null, 2))
}

async function main(): Promise<void> {
  const started = Date.now()
  const { model, provenance } = loadProvider()
  const f = loadFixture()

  // Validate the scripted choice BEFORE any model call or claim (fail fast).
  const HUMAN_CHOICE = process.env.WD_LIVE_CHOICE ?? 'create_draft_pr'
  if (!f.decision_request.options.includes(HUMAN_CHOICE)) {
    throw new Error(`INVALID_CHOICE:${HUMAN_CHOICE} — fixture options: ${f.decision_request.options.join(', ')}`)
  }
  const HUMAN_RATIONALE = process.env.WD_LIVE_RATIONALE ?? RATIONALE[HUMAN_CHOICE]!

  mkdirSync(RUN_DIR, { recursive: true })
  console.log(`[live-loop] provider=${provenance.provider} model=${provenance.modelId} tag=${RUN_TAG}`)
  console.log(`[human] choice=${HUMAN_CHOICE} (scripted); rationale="${HUMAN_RATIONALE.slice(0, 60)}…"`)

  // ── Invocation A: real model, real interrupt ────────────────────────────
  const invocationA = `inv-${randomUUID()}`
  const agent = new Agent({ model, tools: [decisionTool(f)] })
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
  // A rejected claim means this decision was already consumed — invocation B
  // never runs. 'replayed' (same successor + digest) is crash recovery.
  const decidedAt = new Date().toISOString()
  const decisionId = `decision-live-${RUN_TAG}`
  const invocationB = `inv-${randomUUID()}`
  const decisionRecord: DecisionRecord = {
    decisionId,
    chosenOption: HUMAN_CHOICE,
    rationale: HUMAN_RATIONALE,
    decidedAt,
    decisionRequestId: f.stop_id,
    permittedAction: 'dry-run receipt for the approved branch (no external mutation)',
  }
  const store = new ConsumptionStore(CLAIM_DB)
  const claim = store.claim(decisionRecord, invocationB, decisionDigest(decisionRecord))
  if (claim.status === 'rejected') {
    store.close()
    const outcome = `DECISION_ALREADY_CLAIMED:${claim.reason} — ${claim.detail}`
    writeJson('00-live-run-summary.json', {
      tag: RUN_TAG, provider: provenance, invocationA,
      outcome, decisionId, durationMs: Date.now() - started,
    })
    console.log(`[stop] ${outcome}`)
    console.log('[stop] invocation B NOT started — the decision was consumed by a previous run; no model call, no effect.')
    return
  }
  const wasRecovery = claim.status === 'replayed'
  console.log(`[consume-once] claim ${claim.status}${wasRecovery ? ' (crash recovery — same successor)' : ''}; receipt ${claim.receipt.receiptId}`)

  // ── Invocation B: resume the REAL agent with exactly the approved branch ─
  const resumed: AgentResult = await agent.invoke([
    new InterruptResponseContent({
      interruptId: interrupts[0]!.id,
      response: { choice: HUMAN_CHOICE, rationale: HUMAN_RATIONALE },
    }),
  ])
  const finalText = JSON.stringify(resumed.lastMessage?.content ?? [])
  console.log(`[invocation B] ${invocationB} stopReason=${resumed.stopReason}`)
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

  const runtimeDecision = { decisionId, choice: HUMAN_CHOICE, rationale: HUMAN_RATIONALE, decidedAt }
  const evidenceDigest = createHash('sha256').update(JSON.stringify(stop)).digest('hex')
  const humanDecision = buildHumanDecision(f, runtimeDecision, evidenceDigest)
  assertValid('human-decision', humanDecision)

  const effect = {
    schema: 'who-decides.effect-receipt.v0',
    effect: HUMAN_CHOICE,
    mode: 'dry-run',
    exactPayload: HUMAN_CHOICE === 'create_draft_pr'
      ? { repo: 'example/kestrel-app', title: `Security: ${f.package} ${f.to_version}`, branch: `security/${f.package}-${f.to_version}`, authorizedByModel: provenance.modelId }
      : { outcome: HUMAN_CHOICE === 'send_back' ? 'no PR created — work returned' : 'nothing executed — deferred', authorizedByModel: provenance.modelId },
    noExternalMutationPerformed: true,
    authorizedBy: { decisionId, consumptionReceiptId: claim.receipt.receiptId, successorInvocationId: invocationB },
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
    invocationA, invocationB,
    interruptName: interrupts[0]!.name,
    interruptVerified: { question: true, patchId: expectedPatchId, options: true },
    humanChoice: HUMAN_CHOICE,
    decisionId,
    claimStatus: claim.status,
    receiptId: claim.receipt.receiptId,
    duplicateProbe: 'REJECTED (competing_successor)',
    durationMs: Date.now() - started,
  })

  console.log(`[done] ${((Date.now() - started) / 1000).toFixed(1)}s — artifacts in ${RUN_DIR}`)
  console.log(`[done] decision ${decisionId} claimed before execution and consumed exactly once by ${invocationB}; dry-run only; no external mutation.`)
}

main().catch((err) => {
  console.error('[live-loop] FAILED:', err instanceof Error ? err.message : err)
  process.exitCode = 1
})
