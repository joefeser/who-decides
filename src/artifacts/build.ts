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

export function buildHumanDecision(s: Scenario, invocationReceiptDigest: string): Record<string, unknown> {
  const actor = {
    actor_id: s.human_operator,
    actor_kind: 'human',
    actor_verification_source: 'server_session_with_human_interaction',
    authentication_context: {
      interaction_channel: 'web_ui',
      session_reference: `session-${s.run_id}`,
      auth_event_ref: `auth-event-${s.run_id}`,
      secret_material_present: false,
    },
  }
  return {
    hacp_version: 'v0.1-draft',
    record_kind: 'hacp.human_decision_gate',
    decision_id: s.decision_id,
    packet_id: s.packet_id,
    report_id: s.report_id,
    profile_id: 'hacp-base-draft',
    profile_version: 'v0.1-draft',
    decision_matrix_version: 'v0.1-draft',
    from_status: 'needs_human_decision',
    to_status: 'approved',
    decision: 'start_work',
    reason: s.human_choice.rationale,
    created_at: NOW(),
    decided_at: NOW(),
    ...actor,
    actor: { ...actor },
    forbidden_effects_confirmed: ['releases_to_users', 'accepts_risk'],
    evidence_refs: [`finding:${s.finding_tradeoff_id}`, `sha256:${invocationReceiptDigest}`],
    evidence: [`finding:${s.finding_tradeoff_id}`],
  }
}

export function buildAgentReport(
  s: Scenario,
  consumptionReceiptId: string,
  decisionDigest: string,
): Record<string, unknown> {
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
    files_changed: ['package.json', 'package-lock.json'],
    behaviour_implemented: `Prepared ${s.package} ${s.to_version}; stopped at HUMAN_DECISION_REQUIRED; resumed from recorded decision ${s.decision_id}; executed only the approved branch (dry-run receipt).`,
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
    requested_next_step: 'complete',
    boundaries_preserved: true,
    boundary_crossed_reason: null,
    evidence_refs: [
      { ref: `decision:${s.decision_id}`, kind: 'decision_record', summary: `Decision claimed by exactly one successor invocation; receipt ${consumptionReceiptId}` },
      { ref: `consumption:${consumptionReceiptId}`, kind: 'other', summary: `Decision digest sha256:${decisionDigest}` },
    ],
    evidence: [`decision:${s.decision_id}`, `consumption:${consumptionReceiptId}`],
  }
}

export function newInvocationId(): string {
  return `inv-${randomUUID()}`
}
