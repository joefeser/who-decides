/* Host-side AgentCore invocation proxy (AC-3, #19).
 *
 * The console dispatches the deployed agent via the InvokeAgentRuntime AWS
 * API (SigV4 from the host's execution role), maps one runtimeSessionId
 * per console run, and carries the machine service token inside the
 * invocation payload (the boundary AC-2 locked: the platform delivers
 * bodies, not Authorization headers). A test double replaces the AWS
 * client for offline CI; a gated live test can exercise a real endpoint.
 *
 * The proxy is intentionally THIN: it translates console intents
 * (start-run, resume-with-decision) into the agent service's two-phase
 * contract and reports status. No business logic lives here — the engine
 * and the agent service own their state machines. */
import { randomUUID } from 'node:crypto'

export type AgentDispatchRequest =
  | { kind: 'decision-run', sessionId: string }
  | { kind: 'decision-resume', sessionId: string, choice: string, rationale: string }

export type AgentDispatchResult = {
  ok: boolean
  /** The agent service's typed response, passed through. */
  result?: Record<string, unknown>
  error?: string
  /** Dispatch metadata for the console's status surface. */
  dispatch: {
    runtimeSessionId: string
    dispatchedAt: string
    durationMs: number
    transport: 'aws-sdk' | 'test-double' | 'disabled'
  }
}

export type InvokeAgentRuntimeClient = {
  /** Minimal surface of the AWS SDK call we need — a thin seam so tests
   * inject a double and the live path wires the real client. */
  invoke: (payload: Record<string, unknown>) => Promise<Record<string, unknown>>
}

export type AgentDispatchConfig = {
  /** The deployed AgentCore runtime endpoint (ARN or URL). Absent =
   * dispatch disabled; the console falls back to its deterministic
   * engine and reports transport 'disabled'. */
  endpoint?: string
  /** The machine service token delivered to the agent runtime inside the
   * invocation payload (AC-2 boundary). Absent = dispatch disabled. */
  machineToken?: string
}

export function createAgentDispatcher(config: AgentDispatchConfig, client?: InvokeAgentRuntimeClient) {
  const enabled = Boolean(config.endpoint && config.machineToken && client)

  return {
    isEnabled(): boolean {
      return enabled
    },

    async dispatch(request: AgentDispatchRequest): Promise<AgentDispatchResult> {
      const runtimeSessionId = `wd-console-${request.sessionId}`
      const dispatchedAt = new Date().toISOString()
      const started = Date.now()

      if (!enabled) {
        return {
          ok: false,
          error: 'AGENT_DISPATCH_DISABLED',
          dispatch: { runtimeSessionId, dispatchedAt, durationMs: 0, transport: 'disabled' },
        }
      }

      // The payload carries the machine credential (AC-2's boundary) plus
      // the agent service's invocation contract. The AWS client handles
      // SigV4, the runtimeSessionId routing, and payload delivery.
      const payload: Record<string, unknown> = {
        kind: request.kind,
        sessionId: request.sessionId,
        credential: config.machineToken,
      }
      if (request.kind === 'decision-resume') {
        payload.choice = request.choice
        payload.rationale = request.rationale
      }

      try {
        const result = await client!.invoke(payload)
        // The platform can transport an application-level rejection (the
        // agent service's typed 409s) as a successful delivery — derive
        // our ok from the agent service's own response envelope (review P2).
        const agentOk = result.ok !== false
        return {
          ok: agentOk,
          result,
          error: agentOk ? undefined : String((result as { error?: unknown }).error ?? 'AGENT_REJECTED'),
          dispatch: { runtimeSessionId, dispatchedAt, durationMs: Date.now() - started, transport: 'aws-sdk' },
        }
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          dispatch: { runtimeSessionId, dispatchedAt, durationMs: Date.now() - started, transport: 'aws-sdk' },
        }
      }
    },
  }
}

export type AgentDispatcher = ReturnType<typeof createAgentDispatcher>

/** Session-id derivation for a console run — one AgentCore session per
 * console run, stable across the A/B invocation pair. */
export function runtimeSessionIdFor(runId: string): string {
  return `wd-console-${runId}`
}
