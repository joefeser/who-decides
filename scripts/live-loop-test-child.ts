// Synthetic agent used only by test:live-loop. No provider is constructed.
import { appendFileSync } from 'node:fs'
import { main } from '../src/live-loop'

async function run() {
  await main((fixture) => {
    appendFileSync('events.log', 'runtime\n')
    let calls = 0
    return {
      provenance: { provider: 'openai-compatible', modelId: 'synthetic-no-model' },
      agent: {
        async invoke() {
          calls++
          appendFileSync('events.log', calls === 1 ? 'A\n' : 'B\n')
          if (calls === 1) {
            // Give a competing process time to attempt the same fresh tag.
            await new Promise(resolve => setTimeout(resolve, 150))
            return { stopReason: 'interrupt', interrupts: [{ id: 'test-interrupt', name: 'human_release_decision', reason: {
              question: fixture.decision_request.question, patchId: `${fixture.package}-${fixture.to_version}`, options: fixture.decision_request.options,
            } }] } as never
          }
          if (process.env.WD_TEST_CRASH === '1') process.exit(17)
          return { stopReason: 'endTurn', lastMessage: { content: [{ text: 'synthetic completion' }] } } as never
        },
        takeSnapshot() { return { data: { interrupts: { interrupts: { test: { id: 'test-interrupt' } } } } } as never },
        loadSnapshot() { throw new Error('automatic snapshot replay forbidden') },
      },
    }
  })
}
if (process.send) {
  process.send('ready')
  process.once('message', () => { run().catch(error => { console.error(error); process.exitCode = 1 }) })
} else await run()
