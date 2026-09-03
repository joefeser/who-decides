/* Console state engine — the deterministic spine behind the M3 console.
 * Durable server records are authoritative (RULING M3); the browser only
 * polls. State machine: ready → running → decision_required → resuming →
 * completed, plus typed stops. The running phase advances on wall-clock so
 * the timeline is visible without background timers. */
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { assertValid, validateArtifact } from '../artifacts/schemas.js'
import type { ArtifactKind } from '../artifacts/schemas.js'
import {
  buildTaskPacket, buildReviewFindings, buildStopResponse, buildHumanDecision,
  buildAgentReport,
} from '../artifacts/build.js'
import type { Scenario } from '../artifacts/build.js'
import { ConsumptionStore, decisionDigest } from '../consumption/store.js'
import type { DecisionRecord } from '../consumption/store.js'
import { readFileSync } from 'node:fs'

const DB_DIR = process.env.WD_CONSOLE_DIR ?? path.resolve(import.meta.dirname, '../../.tmp/console')
const RUN_RUNNING_MS = 2600
const RUN_RESUMING_MS = 1800

export type RunState = 'running' | 'decision_required' | 'resuming' | 'completed'

export type Milestone = { label: string, detail: string, at: string }

export type ConsoleState = {
  schema: 'who-decides.console-state.v1'
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
  effect: { effect: string, mode: string, noExternalMutation: boolean, payload: Record<string, unknown> } | null
  artifacts: Array<{ name: string, kind: ArtifactKind | 'consumption-receipt' | 'effect-receipt', valid: boolean }>
  heading: string
  subheading: string
}

function loadScenario(): Scenario {
  return JSON.parse(
    readFileSync(path.resolve(import.meta.dirname, '../../fixtures/patch-scenario.json'), 'utf8'),
  ) as Scenario
}

const HEADING: Record<ConsoleState['state'] & string, { heading: string, subheading: string }> = {
  ready: { heading: 'Ready', subheading: 'One click starts invocation A. It never preselects your decision.' },
  running: { heading: 'Running', subheading: 'The agent works in the background. You are not needed yet.' },
  decision_required: { heading: 'Decision required — waiting for you', subheading: 'Invocation A has ended. Nothing will happen until you decide.' },
  resuming: { heading: 'New invocation started from your decision', subheading: 'Invocation B claimed the decision and is executing only the approved branch.' },
  completed: { heading: 'Complete', subheading: 'The decision was consumed exactly once. No external mutation was performed.' },
}

class ConsoleEngine {
  private readonly db: Database.Database
  private readonly consumption: ConsumptionStore

  constructor() {
    mkdirSync(DB_DIR, { recursive: true })
    this.db = new Database(path.join(DB_DIR, 'state.db'))
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        invocation_a TEXT,
        invocation_b TEXT,
        started_at TEXT,
        phase_changed_at TEXT NOT NULL,
        decision_json TEXT,
        receipt_json TEXT,
        effect_json TEXT,
        replay_json TEXT,
        milestones_json TEXT
      );
      CREATE TABLE IF NOT EXISTS artifacts (
        run_id TEXT NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        valid INTEGER NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY (run_id, name)
      );
    `)
    this.consumption = new ConsumptionStore(path.join(DB_DIR, 'consumption.db'))
  }

  currentRun(): { id: string, state: string, phase_changed_at: string } | undefined {
    return this.db
      .prepare('SELECT id, state, phase_changed_at FROM runs ORDER BY started_at DESC LIMIT 1')
      .get() as { id: string, state: string, phase_changed_at: string } | undefined
  }

  startRun(): { runId: string } {
    const existing = this.currentRun()
    if (existing && existing.state !== 'completed') {
      return { runId: existing.id }
    }
    const s = loadScenario()
    const runId = `run-${randomUUID()}`
    const invocationA = `inv-${randomUUID()}`
    const now = new Date().toISOString()
    const milestones: Milestone[] = [
      { label: 'inspect', detail: `${s.package} ${s.from_version} → ${s.to_version} (${s.advisory})`, at: now },
      { label: 'update', detail: `package.json + lockfile prepared`, at: now },
      { label: 'test', detail: s.checks.unit, at: now },
      { label: 'build', detail: s.checks.build, at: now },
    ]
    this.db
      .prepare('INSERT INTO runs (id, state, invocation_a, started_at, phase_changed_at, milestones_json) VALUES (?, ?, ?, ?, ?, ?)')
      .run(runId, 'running', invocationA, now, now, JSON.stringify(milestones))

    const packet = buildTaskPacket(s)
    assertValid('task-packet', packet)
    this.storeArtifact(runId, 'task-packet', 'task-packet', packet)
    const findings = buildReviewFindings(s)
    for (const [i, finding] of findings.entries()) {
      assertValid('review-finding', finding)
      this.storeArtifact(runId, i === 0 ? 'review-finding-green' : 'review-finding-tradeoff', 'review-finding', finding)
    }
    const stop = buildStopResponse(s)
    assertValid('stop-response', stop)
    this.storeArtifact(runId, 'stop-response', 'stop-response', stop)
    return { runId }
  }

  /** Wall-clock phase advance — deterministic, no timers. */
  private advancePhases(run: { id: string, state: string, phase_changed_at: string }): void {
    const elapsed = Date.now() - Date.parse(run.phase_changed_at)
    if (run.state === 'running' && elapsed >= RUN_RUNNING_MS) {
      this.db.prepare('UPDATE runs SET state = ?, phase_changed_at = ? WHERE id = ?')
        .run('decision_required', new Date().toISOString(), run.id)
      run.state = 'decision_required'
    }
    const elapsed2 = Date.now() - Date.parse(run.phase_changed_at)
    if (run.state === 'resuming' && elapsed2 >= RUN_RESUMING_MS) {
      this.db.prepare('UPDATE runs SET state = ?, phase_changed_at = ?, completed_at = ? WHERE id = ?')
        .run('completed', new Date().toISOString(), new Date().toISOString(), run.id)
      run.state = 'completed'
    }
  }

  submitDecision(choice: string, rationale: string): { ok: boolean, error?: string } {
    const run = this.currentRun()
    if (!run) return { ok: false, error: 'NO_RUN' }
    this.advancePhases(run)
    if (run.state !== 'decision_required') return { ok: false, error: `WRONG_STATE:${run.state}` }
    const s = loadScenario()
    if (!s.decision_request.options.includes(choice)) return { ok: false, error: 'INVALID_CHOICE' }
    if (rationale.trim().length === 0) return { ok: false, error: 'RATIONALE_REQUIRED' }

    const decidedAt = new Date().toISOString()
    const decisionRecord: DecisionRecord = {
      decisionId: `decision-${run.id}`,
      chosenOption: choice,
      rationale,
      decidedAt,
      decisionRequestId: s.stop_id,
      permittedAction: 'dry-run receipt for draft PR creation (no external mutation)',
    }

    const invocationB = `inv-${randomUUID()}`
    const claim = this.consumption.claim(decisionRecord, invocationB, decisionDigest(decisionRecord))
    if (claim.status === 'rejected') return { ok: false, error: `CLAIM_REJECTED:${claim.reason}` }

    const humanDecision = buildHumanDecision(s, 'invocation-a-evidence')
    assertValid('human-decision', humanDecision)
    this.storeArtifact(run.id, 'human-decision', 'human-decision', humanDecision)
    this.storeArtifact(run.id, 'consumption-receipt', 'consumption-receipt', claim.receipt)

    const effect = {
      schema: 'who-decides.effect-receipt.v0',
      effect: choice,
      mode: 'dry-run',
      exactPayload: {
        repo: 'example/kestrel-app',
        title: `Security: ${s.package} ${s.to_version}`,
        body: `${s.advisory}\n\nRuntime floor moves ${s.tradeoff.from} → ${s.tradeoff.to}. ${s.tradeoff.who_is_affected}.`,
        branch: `security/${s.package}-${s.to_version}`,
      },
      noExternalMutationPerformed: true,
      authorizedBy: { decisionId: decisionRecord.decisionId, consumptionReceiptId: claim.receipt.receiptId, successorInvocationId: invocationB },
    }
    this.storeArtifact(run.id, 'effect-receipt', 'effect-receipt', effect)

    const report = buildAgentReport(s, claim.receipt.receiptId, claim.receipt.decisionDigest.replace('sha256:', ''))
    assertValid('agent-report', report)
    this.storeArtifact(run.id, 'agent-report', 'agent-report', report)

    this.db
      .prepare('UPDATE runs SET state = ?, invocation_b = ?, phase_changed_at = ?, decision_json = ?, receipt_json = ?, effect_json = ? WHERE id = ?')
      .run('resuming', invocationB, decidedAt, JSON.stringify({ choice, rationale, decidedAt }), JSON.stringify(claim.receipt), JSON.stringify(effect), run.id)
    return { ok: true }
  }

  attemptDuplicateReplay(): { attemptedBy: string, result: string, detail: string } {
    const run = this.currentRun()
    if (!run) throw new Error('NO_RUN')
    const decisionRow = this.db.prepare('SELECT decision_json, receipt_json FROM runs WHERE id = ?').get(run.id) as { decision_json: string, receipt_json: string } | undefined
    if (!decisionRow?.decision_json || !decisionRow?.receipt_json) throw new Error('NOT_RESUMED_YET')
    const decision = JSON.parse(decisionRow.decision_json) as { choice: string, rationale: string, decidedAt: string }
    const receipt = JSON.parse(decisionRow.receipt_json) as { decisionId: string }
    const s = loadScenario()
    const record: DecisionRecord = {
      decisionId: receipt.decisionId,
      chosenOption: decision.choice,
      rationale: decision.rationale,
      decidedAt: decision.decidedAt,
      decisionRequestId: s.stop_id,
      permittedAction: 'dry-run receipt for draft PR creation (no external mutation)',
    }
    const imposter = `inv-${randomUUID()}`
    const result = this.consumption.claim(record, imposter)
    const probe = result.status === 'rejected'
      ? { attemptedBy: imposter, result: `REJECTED (${result.reason})`, detail: result.detail }
      : { attemptedBy: imposter, result: 'CLAIMED — INVARIANT BROKEN', detail: 'consume-once failed!' }
    this.db.prepare('UPDATE runs SET replay_json = ? WHERE id = ?').run(JSON.stringify(probe), run.id)
    return probe
  }

  reset(): void {
    this.db.exec('DELETE FROM runs; DELETE FROM artifacts;')
  }

  private storeArtifact(runId: string, name: string, kind: ArtifactKind | 'consumption-receipt' | 'effect-receipt', artifact: unknown): void {
    const valid = kind.startsWith('who-decides') || kind.includes('receipt')
      ? true
      : validateArtifact(kind as ArtifactKind, artifact).valid
    this.db
      .prepare('INSERT OR REPLACE INTO artifacts (run_id, name, kind, valid, json) VALUES (?, ?, ?, ?, ?)')
      .run(runId, name, kind, valid ? 1 : 0, JSON.stringify(artifact))
  }

  getState(): ConsoleState {
    const run = this.currentRun()
    if (!run) {
      return {
        schema: 'who-decides.console-state.v1',
        runId: '', state: 'ready', invocationA: null, invocationB: null,
        startedAt: null, completedAt: null, milestones: [], decisionRequest: null,
        decision: null, consumption: null, replayProbe: null, effect: null,
        artifacts: [], ...HEADING.ready,
      }
    }
    this.advancePhases(run)
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(run.id) as Record<string, string | null>
    const s = loadScenario()
    const artifacts = (this.db.prepare('SELECT name, kind, valid FROM artifacts WHERE run_id = ? ORDER BY rowid').all(run.id) as Array<{ name: string, kind: string, valid: number }>)
      .map(a => ({ name: a.name, kind: a.kind as ArtifactKind, valid: a.valid === 1 }))
    const decision = row.decision_json ? JSON.parse(row.decision_json) as ConsoleState['decision'] : null
    const receipt = row.receipt_json ? JSON.parse(row.receipt_json) as { receiptId: string, decisionDigest: string, successorInvocationId: string, claimedAt: string } : null
    const effect = row.effect_json ? JSON.parse(row.effect_json) as ConsoleState['effect'] : null
    const replay = row.replay_json ? JSON.parse(row.replay_json) as ConsoleState['replayProbe'] : null
    const state = run.state as ConsoleState['state']
    return {
      schema: 'who-decides.console-state.v1',
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
