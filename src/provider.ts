/* Thin provider adapter — RULING M4: one documented default (Bedrock),
 * one tested OpenAI-compatible escape hatch. Configuration is environment
 * only; there is no settings UI (RULING M3). */
import { OpenAIModel } from '@strands-agents/sdk/models/openai'

export type ProviderKind = 'bedrock' | 'openai-compatible'

export type ProviderConfig = {
  kind: ProviderKind
  /** Human-readable provenance for receipts (never includes secrets). */
  provenance: {
    provider: ProviderKind
    modelId: string
    baseUrl?: string
  }
}

function required(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(
      `ENVIRONMENT_BLOCKED: ${name} is not set. ` +
      'See .env.example for the provider configuration contract.',
    )
  }
  return value
}

export function loadProvider(): ProviderConfig & { model: OpenAIModel } {
  const kind = (process.env.WD_PROVIDER ?? 'openai-compatible') as ProviderKind

  if (kind === 'openai-compatible') {
    const baseUrl = required('WD_BASE_URL')
    const modelId = required('WD_MODEL')
    const apiKey = required('WD_API_KEY')
    const model = new OpenAIModel({
      api: 'chat',
      modelId,
      apiKey,
      clientConfig: { baseURL: baseUrl },
    })
    return {
      kind,
      model,
      provenance: { provider: kind, modelId, baseUrl },
    }
  }

  // Bedrock default path (RULING M4). Uses the SDK's default AWS credential
  // chain; the day-1 gate proves this path before it becomes the default.
  throw new Error(
    'NOT_IMPLEMENTED_YET: Bedrock path is wired on spike day 1 with AWS ' +
    'credentials; run npm run preflight first. WD_PROVIDER is currently ' +
    'fixed to openai-compatible until the Bedrock gate passes.',
  )
}
