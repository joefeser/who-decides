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

export function getAgentDispatcher(): AgentDispatcher {
  if (cached) return cached
  const endpoint = process.env.WD_AGENTCORE_ENDPOINT
  const machineToken = process.env.WD_MACHINE_TOKEN

  if (!endpoint || !machineToken) {
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
        const command = new mod.InvokeAgentRuntimeCommand({
          agentRuntimeArn: endpoint,
          runtimeSessionId: payload.sessionId,
          payload: JSON.stringify(payload),
          contentType: 'application/json',
        })
        const response = await aws.send(command)
        return response
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
