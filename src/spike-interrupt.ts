/* M1 evidence spike: does the Strands TS SDK's interrupt + snapshot system
 * meet the M1 bar for mid-run pause? Tests (RULING M1 / spike-log):
 *   t1     — in-process interrupt, then resume via InterruptResponseContent
 *   save   — run to interrupt, snapshot to disk, exit (process A)
 *   resume — fresh process, loadSnapshot, resume, complete (process B)
 *   replay — restore the SAME snapshot again, resume again (consume-once probe)
 * Each phase prints a receipt with pass/fail assertions. */
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { Agent, FunctionTool, InterruptResponseContent } from '@strands-agents/sdk'
import type { Interrupt } from '@strands-agents/sdk'
import { loadProvider } from './provider.js'

const SNAPSHOT_PATH = '.tmp/spike-interrupt-snapshot.json'
const RESPONSE = { choice: 'create_draft_pr', rationale: 'spike: human approved' }

function receipt(phase: string, assertions: Record<string, unknown>): void {
  const passed = Object.values(assertions).every(v => v === true)
  console.log(JSON.stringify({ schema: 'who-decides.spike-interrupt.v0', phase, passed, assertions }, null, 2))
  if (!passed) process.exitCode = 1
}

function decisionTool(): FunctionTool {
  return new FunctionTool({
    name: 'request_release_decision',
    description: 'Ask the human whether to release the prepared security patch. Use exactly once when preparation is complete.',
    inputSchema: {
      type: 'object',
      properties: { patchId: { type: 'string', description: 'the patch being held' } },
      required: ['patchId'],
    },
    callback(input: unknown, context: { interrupt<T>(params: { name: string, reason?: unknown }): T }) {
      const patchId = (input as { patchId: string }).patchId
      const decision = context.interrupt({
        name: 'human_release_decision',
        reason: {
          question: 'Create the draft PR for this security update?',
          patchId,
          tradeoff: 'tests green, build green, one runtime compatibility check unresolved',
          options: ['create_draft_pr', 'send_back', 'defer'],
        },
      })
      return { status: 'decision_received', decision, note: 'proceeding with exactly the approved branch' }
    },
  })
}

function newAgent(): Agent {
  const { model } = loadProvider()
  return new Agent({ model, tools: [decisionTool()] })
}

async function runToInterrupt(): Promise<{ agent: Agent, interrupts: Interrupt[] }> {
  const agent = newAgent()
  const result = await agent.invoke(
    'Prepare security patch patch-001 (you may say you did), then call request_release_decision exactly once to ask the human, then summarize the outcome.',
  )
  return { agent, interrupts: result.interrupts ?? [] }
}

async function main(): Promise<void> {
  const phase = process.argv[2] ?? 't1'

  if (phase === 't1') {
    const { agent, interrupts } = await runToInterrupt()
    const stop = interrupts.length === 1
    if (!stop) throw new Error(`expected exactly 1 interrupt, got ${interrupts.length}`)
    const resumed = await agent.invoke([
      new InterruptResponseContent({ interruptId: interrupts[0]!.id, response: RESPONSE }),
    ])
    receipt('t1_in_process_resume', {
      interruptRaised: stop,
      interruptHasQuestion: Boolean(interrupts[0]!.reason),
      resumedToEndTurn: resumed.stopReason === 'endTurn',
      noOutstandingInterrupts: (resumed.interrupts ?? []).length === 0,
    })
    return
  }

  if (phase === 'save') {
    const { agent, interrupts } = await runToInterrupt()
    if (interrupts.length !== 1) throw new Error(`expected exactly 1 interrupt, got ${interrupts.length}`)
    const snapshot = agent.takeSnapshot({ preset: 'session' })
    writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2))
    console.log(JSON.stringify({ schema: 'who-decides.spike-interrupt.v0', phase: 'save', snapshotPath: SNAPSHOT_PATH, interruptId: interrupts[0]!.id }))
    return
  }

  if (phase === 'resume' || phase === 'replay') {
    if (!existsSync(SNAPSHOT_PATH)) throw new Error(`ENVIRONMENT_BLOCKED: run "save" first (${SNAPSHOT_PATH} missing)`)
    const stored = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8'))
    const interruptState = stored.data.interrupts as {
      interrupts: Record<string, { id: string }>
      activated?: boolean
      pendingToolExecution?: unknown
    }
    const interruptEntries = Object.values(interruptState?.interrupts ?? {})
    if (interruptEntries.length === 0) throw new Error('no interrupt state in snapshot — snapshot must include interrupts')
    const interruptId = interruptEntries[0]!.id
    const agent = newAgent()
    agent.loadSnapshot(stored)
    const resumed = await agent.invoke([
      new InterruptResponseContent({ interruptId, response: RESPONSE }),
    ])
    receipt(`${phase}_cross_process_resume`, {
      snapshotLoaded: true,
      interruptResolvedFromSnapshot: true,
      resumedToEndTurn: resumed.stopReason === 'endTurn',
      noOutstandingInterrupts: (resumed.interrupts ?? []).length === 0,
    })
    return
  }

  throw new Error(`unknown phase: ${phase} (use t1 | save | resume | replay)`)
}

main().catch((error: unknown) => {
  console.error(`SPIKE_FAILURE: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
