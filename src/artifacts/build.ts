/* Artifact builders for the patch scenario. Shapes follow the canonical
 * valid examples from the hacp repo; every build is validated by the
 * caller (scenario runner) against the vendored schemas. */
import { createHash, randomUUID } from 'node:crypto'

export type Scenario = {
  run_id: string
  packet_id: string
  decision_id: string
  finding_tradeoff_id: string
  report_id: string
  stop_id: string
  package: string
  from_version: string
  to_version: string
  advisory: string
  tradeoff: {
    kind: string
    from: string
    to: string
    who_is_affected: string
    unresolved_check: string
  }
  checks: { unit: string, build: string, audit: string }
  decision_request: { question: string, options: string[], human_terms: string }
  human_choice: { decision: string, rationale: string }
  created_by_agent: string
  human_operator: string
}

const NOW = () => new Date().toISOString()

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function buildTaskPacket(s: Scenario): Record<string, unknown> {
  return {
    hacp_version: 'v0.1-draft',
    record_kind: 'hacp.task_packet',
    packet_id: s.packet_id,
    profile_id: 'hacp-base-draft',
    profile_version: 'v0.1-draft',
    packet_state: 'approved',
    created_at: NOW(),
    created_by: s.human_operator,
    approval: {
      decision_id: `decision-${s.run_id}`,
      actor_id: s.human_operator,
      actor_kind: 'human',
      approved_at: NOW(),
      approved_body_hash: {
        algorithm: 'sha256',
        canonicalization: 'json-c14n',
        digest: sha256(`${s.packet_id}:${s.to_version}`),
      },
    },
    mode: 'implementation_review',
    target_label: `dependency ${s.package}`,
    scope: `Apply ${s.package} ${s.from_version} → ${s.to_version} (${s.advisory}) with bounded verification; stop for a human release decision before any external effect.`,
    authority: 'implement_bounded',
    authority_impact: 'modifies_allowed_surfaces',
    allowed_tools: ['node', 'npm', 'git'],
    allowed_surfaces: ['package.json', 'package-lock.json'],
    forbidden_surfaces: ['app/api', 'schemas'],
    forbidden_effects: ['releases_to_users', 'accepts_risk', 'widens_scope_silently'],
    stop_conditions: [
      'Stop with HUMAN_DECISION_REQUIRED before creating any PR or external effect.',
      'Stop if verification commands fail unexpectedly.',
    ],
    verification_requirements: [
      'npm run test:consumption',
      'npm run scenario',
    ],
    required_report_shape: 'hacp.agent_report',
    evidence_visibility: 'reviewer_only',
    loop_ceiling: 2,
    authority_boundary_notice: 'The agent prepares and requests; the human decides. No effect before a recorded human decision.',
  }
}

export function buildReviewFindings(s: Scenario): Array<Record<string, unknown>> {
  const base = {
    hacp_version: 'v0.1-draft',
    record_kind: 'hacp.review_finding',
    target_id: s.packet_id,
    target_kind: 'task_packet',
    packet_id: s.packet_id,
    profile_id: 'hacp-base-draft',
    profile_version: 'v0.1-draft',
    reviewer_label: 'agent-verification',
    created_at: NOW(),
    created_by: s.created_by_agent,
    evidence: ['fixtures/patch-scenario.json'],
    evidence_refs: ['fixtures/patch-scenario.json'],
  }
  return [
    {
      ...base,
      finding_id: 'finding-2026-09-03-001',
      severity: 'low',
      classification: 'confirmation',
      title: 'Unit suite green on target runtime',
      body: s.checks.unit,
      requires_human_decision: false,
    },
    {
      ...base,
      finding_id: s.finding_tradeoff_id,
      severity: 'high',
      classification: 'needs_human_decision',
      title: `Runtime floor bump: ${s.tradeoff.from} → ${s.tradeoff.to}`,
      body: `${s.tradeoff.who_is_affected}. ${s.tradeoff.unresolved_check}.`,
      impact: s.tradeoff.who_is_affected,
      recommendation: 'Human must own this call: security risk vs runtime floor for node 18 consumers.',
      requires_human_decision: true,
    },
  ]
}

export function buildStopResponse(s: Scenario): Record<string, unknown> {
  return {
    hacp_version: 'v0.1-draft',
    record_kind: 'hacp.stop_response',
    stop_id: s.stop_id,
    packet_id: s.packet_id,
    report_id: s.report_id,
    stop_reason: 'HUMAN_DECISION_REQUIRED',
    what_does_not_line_up: 'The release decision (security risk vs runtime floor for node 18 consumers) belongs to a human; the agent may recommend but not select.',
    evidence_refs: [`finding:${s.finding_tradeoff_id}`],
    minimal_correction: 'A recorded human decision choosing create_draft_pr, send_back, or defer.',
    authority_context: {
      authority: 'implement_bounded',
      forbidden_effects_triggered: [],
    },
  }
}

export type RuntimeDecision = {
  decisionId: string
  choice: string
  rationale: string
  decidedAt: string
}

/** Console choice → HACP decision vocabulary. v0.1-draft has no send_back/defer
 * primitives (v0.3 input); these are the closest protocol-legal mappings. */
const CHOICE_TO_HACP: Record<string, { decision: string, to_status: string }> = {
  create_draft_pr: { decision: 'start_work', to_status: 'in_progress' },
  send_back: { decision: 'request_review', to_status: 'draft' },
  defer: { decision: 'cancel_session', to_status: 'canceled' },
}

export function hacpDecisionFor(choice: string): { decision: string, to_status: string } {
  const mapped = CHOICE_TO_HACP[choice]
  if (!mapped) throw new Error(`UNKNOWN_CHOICE:${choice}`)
  return mapped
}

export function buildHumanDecision(s: Scenario, d: RuntimeDecision, invocationReceiptDigest: string): Record<string, unknown> {
  const { decision, to_status } = hacpDecisionFor(d.choice)
  /* Demo attribution boundary: v0.1-draft has no "unauthenticated local
   * console" actor-verification value (v0.3 input), so the enum stays
   * server_session_with_human_interaction but the free-string references say
   * plainly that no real session was verified. See README "Demo boundaries". */
  const actor = {
    actor_id: s.human_operator,
    actor_kind: 'human',
    actor_verification_source: 'server_session_with_human_interaction',
    authentication_context: {
      interaction_channel: 'web_ui',
      session_reference: 'demo-unauthenticated-local-console',
      auth_event_ref: 'demo-none',
      secret_material_present: false,
    },
  }
  return {
    hacp_version: 'v0.1-draft',
    record_kind: 'hacp.human_decision_gate',
    decision_id: d.decisionId,
    packet_id: s.packet_id,
    report_id: s.report_id,
    profile_id: 'hacp-base-draft',
    profile_version: 'v0.1-draft',
    decision_matrix_version: 'v0.1-draft',
    from_status: 'needs_human_decision',
    to_status,
    decision,
    reason: d.rationale,
    created_at: NOW(),
    decided_at: d.decidedAt,
    ...actor,
    actor: { ...actor },
    forbidden_effects_confirmed: ['releases_to_users', 'accepts_risk'],
    evidence_refs: [`finding:${s.finding_tradeoff_id}`, `sha256:${invocationReceiptDigest}`],
    evidence: [`finding:${s.finding_tradeoff_id}`],
  }
}

export function buildAgentReport(
  s: Scenario,
  d: RuntimeDecision,
  consumptionReceiptId: string,
  decisionDigest: string,
  opts?: { simulatedWorkspace?: boolean },
): Record<string, unknown> {
  const prepared = `Prepared ${s.package} ${s.to_version}; stopped at HUMAN_DECISION_REQUIRED; resumed from recorded decision ${d.decisionId};`
  // files_changed reports invocation A's preparation (real in every branch);
  // the branch difference is the external effect, carried by behaviour + next step.
  const preparedFiles = ['package.json', 'package-lock.json']
  const branch: Record<string, { behaviour: string, files: string[], next: string }> = {
    create_draft_pr: {
      behaviour: `${prepared} executed only the approved branch: dry-run draft-PR receipt (no external mutation).`,
      files: preparedFiles,
      next: 'complete',
    },
    send_back: {
      behaviour: `${prepared} human sent the work back; recorded the feedback, created no PR, and queued the revision branch.`,
      files: preparedFiles,
      next: 'revise_and_resubmit',
    },
    defer: {
      behaviour: `${prepared} human deferred; recorded the deferral and executed nothing.`,
      files: preparedFiles,
      next: 'revisit_on_request',
    },
  }
  const b = branch[d.choice]
  if (!b) throw new Error(`UNKNOWN_CHOICE:${d.choice}`)
  // In a simulated/live-proof run no repository was edited; the schema's
  // files_changed minItems forces one entry, so the report says so itself.
  const behaviour = opts?.simulatedWorkspace
    ? `${b.behaviour} Simulated workspace (fixture scenario): no real repository files were edited.`
    : b.behaviour
  return {
    hacp_version: 'v0.1-draft',
    record_kind: 'hacp.agent_report',
    report_id: s.report_id,
    packet_id: s.packet_id,
    profile_id: 'hacp-base-draft',
    profile_version: 'v0.1-draft',
    created_at: NOW(),
    created_by: s.created_by_agent,
    status: 'completed',
    files_changed: b.files,
    behaviour_implemented: behaviour,
    verification_performed: ['unit suite', 'production build', 'dependency audit'],
    scope_confirmation: {
      scope_preserved: true,
      forbidden_effects_confirmed: ['releases_to_users', 'accepts_risk'],
      out_of_scope_requests: [],
    },
    verification_results: [
      { command: 'unit suite', outcome: 'pass', summary: s.checks.unit },
      { command: 'production build', outcome: 'pass', summary: s.checks.build },
      { command: 'dependency audit', outcome: 'pass', summary: s.checks.audit },
    ],
    linked_finding_ids: [s.finding_tradeoff_id],
    blockers: [],
    residual_risks: [s.tradeoff.unresolved_check],
    requested_next_human_decision: undefined,
    requested_next_step: b.next,
    boundaries_preserved: true,
    boundary_crossed_reason: null,
    evidence_refs: [
      { ref: `decision:${d.decisionId}`, kind: 'decision_record', summary: `Decision claimed by exactly one successor invocation; receipt ${consumptionReceiptId}` },
      { ref: `consumption:${consumptionReceiptId}`, kind: 'other', summary: `Decision digest sha256:${decisionDigest}` },
    ],
    evidence: [`decision:${d.decisionId}`, `consumption:${consumptionReceiptId}`],
  }
}

export function newInvocationId(): string {
  return `inv-${randomUUID()}`
}
