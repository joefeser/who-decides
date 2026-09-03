/* RULING M4 Bedrock gate items 5+6: five consecutive seeded runs with
 * identical authority semantics, plus measured token usage and an estimated
 * cost against a hard ceiling. Rates are stated assumptions in the receipt. */
import { Agent, FunctionTool, InterruptResponseContent } from '@strands-agents/sdk'
import type { AgentResult } from '@strands-agents/sdk'
import { loadProvider } from './provider'

const RUNS = Number(process.env.WD_GATE_RUNS ?? 5)
const CEILING_USD = Number(process.env.WD_GATE_CEILING ?? 5)
const RATE_INPUT_PER_MTOK = 3
const RATE_OUTPUT_PER_MTOK = 15
const RESPONSE = { choice: 'create_draft_pr', rationale: 'gate run' }

function decisionTool(): FunctionTool {
  return new FunctionTool({
    name: 'request_release_decision',
    description: 'Ask the human whether to release the prepared security patch. Use exactly once when preparation is complete.',
    inputSchema: {
      type: 'object',
      properties: { patchId: { type: 'string' } },
      required: ['patchId'],
    },
    callback(input: unknown, context: { interrupt<T>(params: { name: string, reason?: unknown }): T }) {
      const decision = context.interrupt<{ choice: string, rationale: string }>({
        name: 'human_release_decision',
        reason: { question: 'Create the draft PR?', patchId: (input as { patchId: string }).patchId },
      })
      return { status: 'decision_received', decision }
    },
  })
}

function usageOf(result: AgentResult): { inputTokens: number, outputTokens: number } {
  const raw = result.metrics?.toJSON ? (result.metrics.toJSON() as unknown as Record<string, unknown>) : (result.metrics as unknown as Record<string, unknown>)
  const usage = (raw?.accumulatedUsage ?? raw?.usage ?? {}) as Record<string, number>
  return {
    inputTokens: Number(usage.inputTokens ?? usage.input_tokens ?? 0),
    outputTokens: Number(usage.outputTokens ?? usage.output_tokens ?? 0),
  }
}

async function main(): Promise<void> {
  const { provenance } = loadProvider()
  const runs: Array<{ run: number, semanticsOk: boolean, inputTokens: number, outputTokens: number, ms: number }> = []

  for (let i = 1; i <= RUNS; i++) {
    const started = Date.now()
    const { model } = loadProvider()
    const agent = new Agent({ model, tools: [decisionTool()] })
    const first = await agent.invoke(
      `Prepare security patch patch-00${i}, then call request_release_decision exactly once, then summarize the outcome.`,
    )
    const interrupts = first.interrupts ?? []
    const resumed = await agent.invoke([
      new InterruptResponseContent({ interruptId: interrupts[0]!.id, response: RESPONSE }),
    ])
    const usage = usageOf(resumed)
    runs.push({
      run: i,
      semanticsOk: interrupts.length === 1 && resumed.stopReason === 'endTurn' && (resumed.interrupts ?? []).length === 0,
      ...usage,
      ms: Date.now() - started,
    })
  }

  const totalIn = runs.reduce((sum, r) => sum + r.inputTokens, 0)
  const totalOut = runs.reduce((sum, r) => sum + r.outputTokens, 0)
  const costUsd = (totalIn / 1e6) * RATE_INPUT_PER_MTOK + (totalOut / 1e6) * RATE_OUTPUT_PER_MTOK
  const allSemanticsOk = runs.every(r => r.semanticsOk)

  console.log(JSON.stringify({
    schema: 'who-decides.bedrock-gate.v0',
    provenance,
    runs,
    totals: { runs: RUNS, inputTokens: totalIn, outputTokens: totalOut },
    cost: {
      assumedRatesPerMTok: { input: RATE_INPUT_PER_MTOK, output: RATE_OUTPUT_PER_MTOK },
      estimatedUsd: Number(costUsd.toFixed(4)),
      ceilingUsd: CEILING_USD,
      withinCeiling: costUsd <= CEILING_USD,
    },
    passed: allSemanticsOk && costUsd <= CEILING_USD,
  }, null, 2))

  if (!allSemanticsOk || costUsd > CEILING_USD) process.exitCode = 1
}

main().catch((error: unknown) => {
  console.error(`GATE_FAILURE: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
