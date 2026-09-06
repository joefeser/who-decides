/* Dispatcher wiring for the console routes: reads the env configuration
 * once, returns a singleton. When WD_AGENTCORE_ENDPOINT and
 * WD_MACHINE_TOKEN are both set, dispatch is live; otherwise the console
 * runs its deterministic engine and routes receive `agent: undefined`.
 *
 * The live AWS client is loaded lazily — @aws-sdk/client-bedrock-agent-core
 * is an optional peer the deployer installs; its absence with the env set
 * is an ENVIRONMENT_BLOCKED condition reported at startup, not a silent
 * fallback to 'disabled'. */
import { createAgentDispatcher, type AgentDispatcher, type InvokeAgentRuntimeClient } from './agent-dispatch'

let cached: AgentDispatcher | undefined
let cachedError: Error | undefined

/** Call once at server startup (before any route can create a run): a
 * configured-but-missing SDK fails HERE, not after a run exists (review
 * finding — the first route call previously paid the ENVIRONMENT_BLOCKED
 * cost mid-request). Routes calling getAgentDispatcher after a failed init
 * receive the typed disabled stop, never a mid-request throw. */
export function initAgentDispatcher(): void {
  try { getAgentDispatcher() } catch (err) { cachedError = err as Error }
}

export function getAgentDispatcher(): AgentDispatcher {
  if (cached) return cached
  const endpoint = process.env.WD_AGENTCORE_ENDPOINT
  const machineToken = process.env.WD_MACHINE_TOKEN

  if (!endpoint || !machineToken) {
    cached = createAgentDispatcher({})
    return cached
  }
  if (cachedError) {
    // A previous init failed (SDK missing). Routes get the typed disabled
    // stop; the error is reported via the health endpoint, not thrown
    // into an in-flight request.
    cached = createAgentDispatcher({})
    return cached
  }

  // Lazy optional peer: the deployer installs the SDK in the hosted
  // environment; local dev and CI never pay for it.
  let client: InvokeAgentRuntimeClient | undefined
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('@aws-sdk/client-bedrock-agent-core') as {
      BedrockAgentCoreClient: new (config: { region?: string }) => {
        send: (command: unknown) => Promise<Record<string, unknown>>
      },
      InvokeAgentRuntimeCommand: new (input: Record<string, unknown>) => unknown,
    }
    const aws = new mod.BedrockAgentCoreClient({ region: process.env.WD_AWS_REGION ?? 'us-east-1' })
    client = {
      invoke: async (payload) => {
        // Send the dispatcher's reported session id (the prefixed form),
        // not the bare business id — live diagnostics must correlate with
        // the metadata the console surfaces (review P2).
        const runtimeSessionId = `wd-console-${payload.sessionId}`
        const command = new mod.InvokeAgentRuntimeCommand({
          agentRuntimeArn: endpoint,
          runtimeSessionId,
          payload: JSON.stringify(payload),
          contentType: 'application/json',
        })
        const response = await aws.send(command)
        // The SDK returns the agent payload as a streaming body — collect
        // and parse it before returning. Handle BOTH shapes: the Node SDK
        // augments the stream with transformToString(); some runtimes expose
        // a Web Blob with .text() (review P1).
        const body = response.response ?? response.payload ?? response.body
        if (body && typeof body === 'object') {
          const b = body as { text?: unknown, transformToString?: unknown }
          if (typeof b.transformToString === 'function') {
            const text = await (b as { transformToString: (enc?: string) => Promise<string> }).transformToString('utf-8')
            try { return JSON.parse(text) as Record<string, unknown> } catch { return { rawResponse: text } }
          }
          if (typeof b.text === 'function') {
            const text = await (b as { text: () => Promise<string> }).text()
            try { return JSON.parse(text) as Record<string, unknown> } catch { return { rawResponse: text } }
          }
        }
        return response as Record<string, unknown>
      },
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('Cannot find module')) {
      throw new Error(
        `ENVIRONMENT_BLOCKED: WD_AGENTCORE_ENDPOINT is set but @aws-sdk/client-bedrock-agent-core is not installed. ` +
        'Install it in the hosted environment or unset the endpoint to run the deterministic console.',
      )
    }
    throw err
  }

  cached = createAgentDispatcher({ endpoint, machineToken }, client)
  return cached
}

/** The startup error, if init failed — surfaced by the health endpoint. */
export function agentDispatcherError(): Error | undefined {
  return cachedError
}
