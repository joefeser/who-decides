/* Escape-hatch smoke — RULING M4 gate item: "a minimal OpenAI-compatible
 * smoke proves the escape hatch" on the EXACT fallback configuration we
 * would actually adopt. Proves: adapter boundary, documented credential
 * path, one minimal agent invocation. Prints a provenance receipt. */
import { Agent } from '@strands-agents/sdk'
import { loadProvider } from './provider'

async function main(): Promise<void> {
  const { model, provenance } = loadProvider()

  const agent = new Agent({ model })
  const result = await agent.invoke(
    'Reply with exactly the word: operational. Nothing else.',
  )

  const textDump = JSON.stringify(result.lastMessage.content)
  const passed = result.stopReason === 'endTurn'

  console.log(
    JSON.stringify(
      {
        schema: 'who-decides.smoke.v0',
        passed,
        reply: textDump.slice(0, 200),
        stopReason: result.stopReason,
        provenance: {
          ...provenance,
          strandsSdk: '1.16.0',
          checkedAt: new Date().toISOString(),
        },
      },
      null,
      2,
    ),
  )

  if (!passed) {
    process.exitCode = 1
  }
}

main().catch((error: unknown) => {
  console.error(
    `ENVIRONMENT_BLOCKED: ${error instanceof Error ? error.message : String(error)}`,
  )
  process.exitCode = 1
})
