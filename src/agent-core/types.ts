/* Shared types for the agent's two-phase lifecycle. Both the CLI
 * (src/live-loop.ts) and the AgentCore HTTP service (src/agent-service/)
 * drive the same phase functions with these shapes — the lessons live in
 * one place, not per-surface. */
import type { Agent } from '@strands-agents/sdk'

export type Phase = 'awaiting_decision' | 'claimed' | 'completed' | 'rejected'

export type RunState = {
  phase: Phase
  decisionId: string
  choice: string
  rationale: string
  decidedAt: string
  invocationA: string
  invocationB: string
  receiptId?: string
  outcome?: string
}

/** Injectable runtime seam — tests supply a synthetic agent; production
 * constructs a real Strands Agent against the configured provider. */
export type AgentRuntime = {
  agent: Pick<Agent, 'invoke' | 'loadSnapshot' | 'takeSnapshot'>
  provenance: { provider: string, modelId: string }
}

export type RuntimeFactory = (fixture: import('../artifacts/build').Scenario) => AgentRuntime

/** Phase A input: everything needed to start a run to its decision point. */
export type StartInput = {
  tag: string
}

/** Phase A output: the typed decision request the human must answer. */
export type StartOutput =
  | { status: 'DECISION_REQUIRED', decisionId: string, invocationA: string, decisionRequest: { question: string, patchId: string, options: string[], tradeoff: string } }
  | { status: 'RUN_ALREADY_COMPLETED', decisionId: string, invocationB: string, receiptId?: string }
  | { status: 'RUN_PREVIOUSLY_REJECTED', outcome: string }
  | { status: 'HUMAN_DECISION_REQUIRED', reason: string }
  | { status: 'ENVIRONMENT_BLOCKED', reason: string }

/** Phase B input: the recorded human decision. */
export type ResumeInput = {
  tag: string
  choice: string
  rationale: string
}

/** Phase B output. */
export type ResumeOutput =
  | { status: 'COMPLETED', decisionId: string, invocationB: string, receiptId: string, effect: Record<string, unknown> }
  | { status: 'DUPLICATE', decisionId: string, receiptId?: string }
  | { status: 'DECISION_ALREADY_RECORDED', decisionId: string }
  | { status: 'CLAIM_REJECTED', reason: string }
  | { status: 'HUMAN_DECISION_REQUIRED', reason: string }
  | { status: 'INVALID_INPUT', reason: string }
  | { status: 'STATE_CONFLICT', reason: string }
