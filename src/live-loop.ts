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
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
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

const OUT_DIR = path.resolve(process.cwd(), '.tmp/live-run')
const RUN_TAG = process.env.WD_LIVE_TAG ?? new Date().toISOString().replace(/[:.]/g, '-')

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
  writeFileSync(path.join(OUT_DIR, name), JSON.stringify(value, null, 2))
}

async function main(): Promise<void> {
  const started = Date.now()
  const { model, provenance } = loadProvider()
  const f = loadFixture()
  rmSync(OUT_DIR, { recursive: true, force: true })
  mkdirSync(OUT_DIR, { recursive: true })

  console.log(`[live-loop] provider=${provenance.provider} model=${provenance.modelId} tag=${RUN_TAG}`)

  // ── Invocation A: real model, real interrupt ────────────────────────────
  const invocationA = `inv-${randomUUID()}`
  const agent = new Agent({ model, tools: [decisionTool(f)] })
  const first = await agent.invoke(promptFor(f))
  const interrupts: Interrupt[] = first.interrupts ?? []
  console.log(`[invocation A] ${invocationA} stopReason=${first.stopReason} interrupts=${interrupts.length}`)
  if (interrupts.length !== 1 || first.stopReason !== 'interrupt') {
    throw new Error(`INVARIANT: expected exactly one interrupt stop, got stopReason=${first.stopReason}, interrupts=${interrupts.length}`)
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

  // ── The human decides (scripted; in the product this is the console) ────
  const HUMAN_CHOICE = process.env.WD_LIVE_CHOICE ?? 'create_draft_pr'
  const HUMAN_RATIONALE = 'Security risk outweighs the runtime-floor bump; node 20 is our target platform.'
  const decidedAt = new Date().toISOString()
  const decisionId = `decision-live-${RUN_TAG}`
  console.log(`[human] choice=${HUMAN_CHOICE} (scripted)`)

  // ── Invocation B: resume the REAL agent with exactly the approved branch ─
  const invocationB = `inv-${randomUUID()}`
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
    throw new Error(`INVARIANT: resume should end the turn, got ${resumed.stopReason}`)
  }

  // ── Consume-once + artifacts from runtime truth ──────────────────────────
  const dbPath = path.join(OUT_DIR, 'consumption.db')
  const store = new ConsumptionStore(dbPath)
  const decisionRecord: DecisionRecord = {
    decisionId,
    chosenOption: HUMAN_CHOICE,
    rationale: HUMAN_RATIONALE,
    decidedAt,
    decisionRequestId: f.stop_id,
    permittedAction: 'dry-run receipt for the approved branch (no external mutation)',
  }
  const claim = store.claim(decisionRecord, invocationB, decisionDigest(decisionRecord))
  if (claim.status !== 'claimed') {
    store.close()
    throw new Error(`INVARIANT: first claim must succeed, got ${claim.status}`)
  }

  // Live duplicate probe: a second successor must fail closed.
  const imposter = `inv-${randomUUID()}`
  const duplicate = store.claim(decisionRecord, imposter)
  store.close()
  if (duplicate.status !== 'rejected' || duplicate.reason !== 'competing_successor') {
    throw new Error('INVARIANT: duplicate claim did not fail closed')
  }
  console.log('[consume-once] claim ok; duplicate probe REJECTED (competing_successor)')

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
  const report = buildAgentReport(f, runtimeDecision, claim.receipt.receiptId, claim.receipt.decisionDigest.replace('sha256:', ''))
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
    humanChoice: HUMAN_CHOICE,
    decisionId,
    receiptId: claim.receipt.receiptId,
    duplicateProbe: 'REJECTED (competing_successor)',
    durationMs: Date.now() - started,
  })

  console.log(`[done] ${((Date.now() - started) / 1000).toFixed(1)}s — artifacts in ${OUT_DIR}`)
  console.log(`[done] decision ${decisionId} consumed exactly once by ${invocationB}; dry-run only; no external mutation.`)
}

main().catch((err) => {
  console.error('[live-loop] FAILED:', err instanceof Error ? err.message : err)
  process.exitCode = 1
})
