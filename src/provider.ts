/* Thin provider adapter — RULING M4: one documented default (Bedrock),
 * one tested OpenAI-compatible escape hatch. Configuration is environment
 * only; there is no settings UI (RULING M3). */
import { OpenAIModel } from '@strands-agents/sdk/models/openai'
import { BedrockModel } from '@strands-agents/sdk/models/bedrock'

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

export function loadProvider(): ProviderConfig & { model: OpenAIModel | BedrockModel } {
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

  // Bedrock default path (RULING M4). Credentials come from the AWS default
  // chain (e.g. AWS_PROFILE=who-decides); region/model pinned per gate.
  const modelId = process.env.WD_BEDROCK_MODEL ?? 'global.anthropic.claude-sonnet-4-6'
  const region = process.env.WD_AWS_REGION ?? 'us-east-1'
  const model = new BedrockModel({ modelId, region })
  return {
    kind,
    model,
    provenance: { provider: kind, modelId, region },
  }
}
