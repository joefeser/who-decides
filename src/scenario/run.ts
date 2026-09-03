/* Deterministic end-to-end scenario run — the demo's data spine, no model:
 * packet → findings → typed stop (HUMAN_DECISION_REQUIRED) → scripted human
 * decision → ATOMIC consumption claim → dry-run effect receipt → agent
 * report. Every HACP artifact is validated against the vendored v0.1-draft
 * schemas; the run receipt proves the whole chain. */
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { assertValid } from '../artifacts/schemas'
import {
  buildTaskPacket, buildReviewFindings, buildStopResponse, buildHumanDecision,
  buildAgentReport, newInvocationId,
} from '../artifacts/build'
import type { Scenario } from '../artifacts/build'
import { ConsumptionStore, decisionDigest } from '../consumption/store'
import type { DecisionRecord } from '../consumption/store'

function loadScenario(): Scenario {
  const file = process.env.WD_SCENARIO ?? path.resolve(import.meta.dirname, '../../fixtures/patch-scenario.json')
  return JSON.parse(readFileSync(file, 'utf8')) as Scenario
}

async function main(): Promise<void> {
  const s = loadScenario()
  const outDir = process.env.WD_SCENARIO_OUT ?? path.resolve(import.meta.dirname, '../../.tmp/scenario-run')
  mkdirSync(outDir, { recursive: true })
  const artifacts: Array<{ name: string, kind: Parameters<typeof assertValid>[0], artifact: unknown }> = []

  // 1 — invocation A prepares, finds the tradeoff, stops.
  const taskPacket = buildTaskPacket(s)
  assertValid('task-packet', taskPacket)
  artifacts.push({ name: 'task-packet', kind: 'task-packet', artifact: taskPacket })

  const findings = buildReviewFindings(s)
  for (const finding of findings) assertValid('review-finding', finding)
  artifacts.push({ name: 'review-findings', kind: 'review-finding', artifact: findings })

  const stop = buildStopResponse(s)
  assertValid('stop-response', stop)
  artifacts.push({ name: 'stop-response', kind: 'stop-response', artifact: stop })

  // 2 — the human decides (fixture-scripted; in the real demo this is the console).
  const decidedAt = new Date().toISOString()
  const runtimeDecision = {
    decisionId: s.decision_id,
    choice: s.human_choice.decision,
    rationale: s.human_choice.rationale,
    decidedAt,
  }
  const decisionRecord: DecisionRecord = {
    decisionId: s.decision_id,
    chosenOption: s.human_choice.decision,
    rationale: s.human_choice.rationale,
    decidedAt,
    decisionRequestId: s.stop_id,
    permittedAction: 'dry-run receipt for the approved branch (no external mutation)',
  }
  const humanDecision = buildHumanDecision(s, runtimeDecision, 'invocation-a-evidence')
  assertValid('human-decision', humanDecision)
  artifacts.push({ name: 'human-decision', kind: 'human-decision', artifact: humanDecision })

  // 3 — invocation B claims the decision atomically, then runs only the approved branch.
  const invocationB = newInvocationId()
  const dbDir = mkdtempSync(path.join(tmpdir(), 'wd-scenario-'))
  const dbPath = path.join(dbDir, 'consumption.db')
  const store = new ConsumptionStore(dbPath)
  const claim = store.claim(decisionRecord, invocationB, decisionDigest(decisionRecord))
  if (claim.status === 'rejected') {
    store.close()
    rmSync(dbDir, { recursive: true, force: true })
    throw new Error(`claim rejected: ${claim.reason} — ${claim.detail}`)
  }
  const receipt = claim.receipt

  // A duplicate attempt by a different successor must fail closed — live, every run.
  const duplicate = store.claim(decisionRecord, newInvocationId())
  store.close()
  rmSync(dbDir, { recursive: true, force: true })
  if (duplicate.status !== 'rejected' || duplicate.reason !== 'competing_successor') {
    throw new Error('duplicate claim did not fail closed — consume-once invariant broken')
  }

  // 4 — dry-run effect receipt (the effect; no external mutation).
  const dryRunEffect = {
    schema: 'who-decides.effect-receipt.v0',
    effect: 'create_draft_pr',
    mode: 'dry-run',
    exactPayload: {
      repo: 'example/kestrel-app',
      title: `Security: ${s.package} ${s.to_version}`,
      body: `${s.advisory}\n\nRuntime floor moves ${s.tradeoff.from} → ${s.tradeoff.to}. ${s.tradeoff.who_is_affected}.`,
      branch: `security/${s.package}-${s.to_version}`,
    },
    noExternalMutationPerformed: true,
    authorizedBy: { decisionId: s.decision_id, consumptionReceiptId: receipt.receiptId, successorInvocationId: invocationB },
  }

  // 5 — the agent report correlates decision → outcome.
  const report = buildAgentReport(s, runtimeDecision, receipt.receiptId, receipt.decisionDigest.replace('sha256:', ''))
  assertValid('agent-report', report)
  artifacts.push({ name: 'agent-report', kind: 'agent-report', artifact: report })

  for (const a of artifacts) {
    writeFileSync(path.join(outDir === '' ? '.' : outDir, `${a.name}.json`), JSON.stringify(a.artifact, null, 2))
  }
  writeFileSync(path.join(outDir, 'effect-receipt.json'), JSON.stringify(dryRunEffect, null, 2))
  writeFileSync(path.join(outDir, 'consumption-receipt.json'), JSON.stringify(receipt, null, 2))

  console.log(JSON.stringify({
    schema: 'who-decides.scenario-run.v0',
    passed: true,
    runId: s.run_id,
    invocationB,
    claimStatus: claim.status,
    consumptionReceiptId: receipt.receiptId,
    decisionDigest: receipt.decisionDigest,
    validatedArtifacts: artifacts.map(a => a.kind),
    dryRunEffect: { effect: dryRunEffect.effect, mode: 'dry-run', noExternalMutation: true },
    outputDir: outDir,
  }, null, 2))
}

main().catch((error: unknown) => {
  console.error(`SCENARIO_FAILURE: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
