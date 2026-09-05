import type { Digest } from './jcs'

export const FIXED_ACTION = {
  operationId: 'observe_fixed_payload',
  parameters: { payload: 'HACP_LOCAL_OWNER_CONTINUATION_PROBE_V1' },
} as const
export const FIXED_OBSERVATION = {
  operationId: 'observe_fixed_payload',
  payload: 'HACP_LOCAL_OWNER_CONTINUATION_PROBE_V1',
} as const
export const OBSERVATION_DIGEST_VALUE = '2291610e38245f88bac99efc480897600b1f322a4004d0113487033a3b13de5e'

export type ClockSample = { wallTime: string, monotonicNanoseconds: string }
export type CandidateStop = 'MISSING_AUTHORITY' | 'SCOPE_CONFLICT' | 'STALE_PACKET'
  | 'UNVERIFIED_ASSUMPTION' | 'ENVIRONMENT_BLOCKED' | 'HUMAN_DECISION_REQUIRED'
export type CandidateResult<T> = { ok: true, value: T } | { ok: false, stop: CandidateStop, detail: string }
export type BaseDecision = Record<string, unknown>
export type DecisionInput = {
  decisionId: string, humanEventRef: string, baseDecisionRef: string,
  baseDecisionDigest: Digest, requestRef: string, action: typeof FIXED_ACTION,
  approvedAt: string, expiresAt: string, baseDecision: BaseDecision,
}
export type ClaimInput = {
  decisionId: string, decisionDigest: Digest, claimId: string, attemptKey: string,
  successorId: string, requestRef: string, action: typeof FIXED_ACTION,
  claimedAt: string, expiresAt: string,
}
export type StartInput = { decisionId: string, claimId: string, intentId: string, successorId: string, action: typeof FIXED_ACTION }
