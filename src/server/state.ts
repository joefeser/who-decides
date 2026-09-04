/* Console state engine — the deterministic spine behind the M3 console.
 * Durable server records are authoritative (RULING M3); the browser only
 * polls. State machine: ready → running → decision_required → resuming →
 * completed, plus typed stops. The running phase advances on wall-clock so
 * the timeline is visible without background timers. */
import { randomUUID, createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { assertValid, validateArtifact } from '../artifacts/schemas'
import type { ArtifactKind } from '../artifacts/schemas'
import {
  buildTaskPacket, buildReviewFindings, buildStopResponse, buildHumanDecision,
  buildAgentReport,
} from '../artifacts/build'
import type { Scenario } from '../artifacts/build'
import { ConsumptionStore, decisionDigest } from '../consumption/store'
import type { DecisionRecord } from '../consumption/store'
import { readFileSync } from 'node:fs'

const DB_DIR = process.env.WD_CONSOLE_DIR ?? path.resolve(process.cwd(), '.tmp/console')
const RUN_RUNNING_MS = 2600
const RUN_RESUMING_MS = 1800

export type RunState = 'running' | 'decision_required' | 'resuming' | 'completed'

export type Milestone = { label: string, detail: string, at: string }

export type ConsoleState = {
  schema: 'who-decides.console-state.v1'
  tenantId: string
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
  artifacts: Array<{ name: string, kind: ArtifactKind | 'consumption-receipt' | 'effect-receipt', valid: boolean }>
  heading: string
  subheading: string
}

function loadScenario(): Scenario {
  return JSON.parse(
    readFileSync(path.resolve(process.cwd(), 'fixtures/patch-scenario.json'), 'utf8'),
  ) as Scenario
}

const HEADING: Record<ConsoleState['state'] & string, { heading: string, subheading: string }> = {
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
  private readonly db: Database.Database
  private readonly consumption: ConsumptionStore
  /** Known-tenant scoping: one engine instance serves one tenant's runs.
   * Multi-process deployments run one process per tenant, or one process per
   * tenant pool, with separate state directories. The default keeps the
   * single-operator local demo behavior unchanged. */
  readonly tenant: string

  constructor(tenant: string = process.env.WD_TENANT_ID ?? 'default') {
    this.tenant = tenant
    const dir = process.env.WD_CONSOLE_DIR ?? DB_DIR
    mkdirSync(dir, { recursive: true })
    this.db = new Database(path.join(dir, 'state.db'))
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        tenant_id TEXT NOT NULL DEFAULT 'default',
        invocation_a TEXT,
        invocation_b TEXT,
        started_at TEXT,
        completed_at TEXT,
        phase_changed_at TEXT NOT NULL,
        decision_json TEXT,
        receipt_json TEXT,
        effect_json TEXT,
        replay_json TEXT,
        milestones_json TEXT,
        archived INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS artifacts (
        run_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL DEFAULT 'default',
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        valid INTEGER NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY (run_id, name)
      );
    `)
    // Pre-column databases (dev .tmp): add the columns in place.
    try { this.db.exec("ALTER TABLE runs ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default'") } catch { /* column exists */ }
    try { this.db.exec("ALTER TABLE artifacts ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default'") } catch { /* column exists */ }
    try { this.db.exec('ALTER TABLE runs ADD COLUMN archived INTEGER NOT NULL DEFAULT 0') } catch { /* column exists */ }
    this.consumption = new ConsumptionStore(path.join(dir, 'consumption.db'))
  }

  currentRun(): { id: string, state: string, phase_changed_at: string } | undefined {
    return this.db
      .prepare('SELECT id, state, phase_changed_at FROM runs WHERE archived = 0 AND tenant_id = ? ORDER BY started_at DESC LIMIT 1')
      .get(this.tenant) as { id: string, state: string, phase_changed_at: string } | undefined
  }

  startRun(): { runId: string } {
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
    // One-active-run enforced inside an immediate transaction: a concurrent
    // caller cannot slip a second active run between check and insert.
    let existingId: string | null = null
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const existing = this.currentRun()
      if (existing && existing.state !== 'completed') {
        existingId = existing.id
      } else {
        this.db
          .prepare('INSERT INTO runs (id, state, tenant_id, invocation_a, started_at, phase_changed_at, milestones_json) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(runId, 'running', this.tenant, invocationA, now, now, JSON.stringify(milestones))
      }
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
    if (existingId) return { runId: existingId }

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

  submitDecision(choice: string, rationale: string, idempotencyKey?: string): { ok: boolean, duplicate?: boolean, error?: string } {
    const run = this.currentRun()
    if (!run) return { ok: false, error: 'NO_RUN' }
    this.advancePhases(run)
    const row = this.db.prepare('SELECT decision_json, invocation_b FROM runs WHERE id = ?').get(run.id) as { decision_json: string | null, invocation_b: string | null }
    const prior = row.decision_json ? JSON.parse(row.decision_json) as { choice: string, rationale: string, decidedAt: string, idempotencyKey: string | null } : null

    // Idempotent recovery, matched strictly: only the SAME submission (key +
    // choice) may return committed success. A different decision arriving
    // after one was recorded is a conflict — the first decision was consumed.
    if (run.state !== 'decision_required') {
      if (prior && prior.choice === choice && prior.idempotencyKey === (idempotencyKey ?? null)) {
        return { ok: true, duplicate: true }
      }
      if (prior) return { ok: false, error: 'DECISION_ALREADY_RECORDED' }
      return { ok: false, error: `WRONG_STATE:${run.state}` }
    }
    const s = loadScenario()
    if (!s.decision_request.options.includes(choice)) return { ok: false, error: 'INVALID_CHOICE' }
    if (rationale.trim().length === 0) return { ok: false, error: 'RATIONALE_REQUIRED' }
    if (prior && prior.choice !== choice) return { ok: false, error: 'DECISION_ALREADY_RECORDED' }

    // Persist the decision intent (choice, rationale, decidedAt, successor id)
    // BEFORE claiming, so a crash between claim and state-write leaves a
    // retry that reuses the same successor and same digest → 'replayed',
    // never a competing successor. Only a first submission may set them.
    const invocationB = row.invocation_b ?? `inv-${randomUUID()}`
    const decidedAt = prior?.decidedAt ?? new Date().toISOString()
    const effectiveChoice = prior?.choice ?? choice
    const effectiveRationale = prior?.rationale ?? rationale
    if (!prior) {
      this.db
        .prepare('UPDATE runs SET invocation_b = ?, decision_json = ? WHERE id = ? AND decision_json IS NULL')
        .run(invocationB, JSON.stringify({ choice: effectiveChoice, rationale: effectiveRationale, decidedAt, idempotencyKey: idempotencyKey ?? null }), run.id)
    }

    const decisionId = `decision-${run.id}`
    const decisionRecord = this.decisionRecord(decisionId, effectiveChoice, effectiveRationale, decidedAt)

    const claim = this.consumption.claim(decisionRecord, invocationB, decisionDigest(decisionRecord))
    if (claim.status === 'rejected') return { ok: false, error: `CLAIM_REJECTED:${claim.reason}` }

    const runtimeDecision = {
      decisionId: decisionRecord.decisionId,
      choice: effectiveChoice,
      rationale: effectiveRationale,
      decidedAt,
    }
    const humanDecision = buildHumanDecision(s, runtimeDecision, this.evidenceDigest(run.id))
    assertValid('human-decision', humanDecision)
    this.storeArtifact(run.id, 'human-decision', 'human-decision', humanDecision)
    this.storeArtifact(run.id, 'consumption-receipt', 'consumption-receipt', claim.receipt)

    const effect = this.buildEffect(s, effectiveChoice, runtimeDecision.decisionId, claim.receipt.receiptId, invocationB)
    this.storeArtifact(run.id, 'effect-receipt', 'effect-receipt', effect)

    const report = buildAgentReport(s, runtimeDecision, claim.receipt.receiptId, claim.receipt.decisionDigest.replace('sha256:', ''))
    assertValid('agent-report', report)
    this.storeArtifact(run.id, 'agent-report', 'agent-report', report)

    this.db
      .prepare('UPDATE runs SET state = ?, phase_changed_at = ?, receipt_json = ?, effect_json = ? WHERE id = ?')
      .run('resuming', decidedAt, JSON.stringify(claim.receipt), JSON.stringify(effect), run.id)
    return { ok: true }
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

  attemptDuplicateReplay(): { attemptedBy: string, result: string, detail: string } {
    const run = this.currentRun()
    if (!run) throw new Error('NO_RUN')
    const decisionRow = this.db.prepare('SELECT decision_json, receipt_json FROM runs WHERE id = ?').get(run.id) as { decision_json: string, receipt_json: string } | undefined
    if (!decisionRow?.decision_json || !decisionRow?.receipt_json) throw new Error('NOT_RESUMED_YET')
    const decision = JSON.parse(decisionRow.decision_json) as { choice: string, rationale: string, decidedAt: string }
    const receipt = JSON.parse(decisionRow.receipt_json) as { decisionId: string }
    const record = this.decisionRecord(receipt.decisionId, decision.choice, decision.rationale, decision.decidedAt)
    const imposter = `inv-${randomUUID()}`
    const result = this.consumption.claim(record, imposter)
    const probe = result.status === 'rejected'
      ? { attemptedBy: imposter, result: `REJECTED (${result.reason})`, detail: result.detail }
      : { attemptedBy: imposter, result: 'CLAIMED — INVARIANT BROKEN', detail: 'consume-once failed!' }
    this.db.prepare('UPDATE runs SET replay_json = ? WHERE id = ?').run(JSON.stringify(probe), run.id)
    return probe
  }

  /** Real digest (raw hex; the builder adds the sha256: prefix) of the
   * invocation-A evidence the decision responds to — never a placeholder. */
  private evidenceDigest(runId: string): string {
    const row = this.db.prepare("SELECT json FROM artifacts WHERE run_id = ? AND name = 'stop-response'").get(runId) as { json: string } | undefined
    if (!row) throw new Error('EVIDENCE_MISSING:stop-response')
    return createHash('sha256').update(row.json).digest('hex')
  }

  private decisionRecord(decisionId: string, choice: string, rationale: string, decidedAt: string): DecisionRecord {
    const s = loadScenario()
    return {
      decisionId,
      chosenOption: choice,
      rationale,
      decidedAt,
      decisionRequestId: s.stop_id,
      permittedAction: 'dry-run receipt for the approved branch (no external mutation)',
    }
  }

  /** Reset clears the live console without destroying completed audit
   * records — HACP artifacts survive the demo loop (Codex P2). Only THIS
   * tenant's console is cleared; other tenants' runs are untouched. */
  reset(): void {
    this.db.prepare('UPDATE runs SET archived = 1 WHERE tenant_id = ?').run(this.tenant)
  }

  close(): void {
    this.consumption.close()
    this.db.close()
  }

  private storeArtifact(runId: string, name: string, kind: ArtifactKind | 'consumption-receipt' | 'effect-receipt', artifact: unknown): void {
    const valid = kind === 'consumption-receipt' || kind === 'effect-receipt'
      ? validateReceipt(kind, artifact)
      : validateArtifact(kind, artifact).valid
    if (!valid) throw new Error(`ARTIFACT_INVALID:${kind}:${name}`)
    this.db
      .prepare('INSERT OR REPLACE INTO artifacts (run_id, tenant_id, name, kind, valid, json) VALUES (?, ?, ?, ?, ?, ?)')
      .run(runId, this.tenant, name, kind, valid ? 1 : 0, JSON.stringify(artifact))
  }

  getState(): ConsoleState {
    const run = this.currentRun()
    if (!run) {
      return {
        schema: 'who-decides.console-state.v1',
        tenantId: this.tenant,
        runId: '', state: 'ready', invocationA: null, invocationB: null,
        startedAt: null, completedAt: null, milestones: [], decisionRequest: null,
        decision: null, consumption: null, replayProbe: null, effect: null,
        artifacts: [], ...HEADING.ready,
      }
    }
    this.advancePhases(run)
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(run.id) as Record<string, string | null>
    const s = loadScenario()
    const artifacts = (this.db.prepare('SELECT name, kind, valid FROM artifacts WHERE run_id = ? AND tenant_id = ? ORDER BY rowid').all(run.id, this.tenant) as Array<{ name: string, kind: string, valid: number }>)
      .map(a => ({ name: a.name, kind: a.kind as ArtifactKind, valid: a.valid === 1 }))
    const decision = row.decision_json ? JSON.parse(row.decision_json) as ConsoleState['decision'] : null
    const receipt = row.receipt_json ? JSON.parse(row.receipt_json) as { receiptId: string, decisionDigest: string, successorInvocationId: string, claimedAt: string } : null
    const effect = row.effect_json ? JSON.parse(row.effect_json) as ConsoleState['effect'] : null
    const replay = row.replay_json ? JSON.parse(row.replay_json) as ConsoleState['replayProbe'] : null
    const state = run.state as ConsoleState['state']
    return {
      schema: 'who-decides.console-state.v1',
      tenantId: this.tenant,
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
