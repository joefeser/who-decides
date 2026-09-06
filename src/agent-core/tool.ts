/* The decision tool, prompt, and per-choice rationale defaults — shared by
 * the CLI live-loop and the AgentCore service so the agent's behavior is
 * identical on both surfaces. */
import { FunctionTool } from '@strands-agents/sdk'
import type { Scenario } from '../artifacts/build'

/** Default rationale per choice — an approval argument must never be recorded
 * against a send_back/defer decision. */
export const RATIONALE: Record<string, string> = {
  create_draft_pr: 'Security risk outweighs the runtime-floor bump; node 20 is our target platform.',
  send_back: 'The runtime-floor bump needs an answer for node 18 consumers before we ship this; resolve that and resubmit.',
  defer: 'Not now — revisit at the next planning session; nothing should execute meanwhile.',
}

export function decisionTool(f: Scenario): FunctionTool {
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

export function promptFor(f: Scenario): string {
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
