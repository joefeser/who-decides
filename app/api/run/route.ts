import { NextRequest, NextResponse } from 'next/server'
import engine from '../../../src/server/state'
import { requireOperator } from '../../../src/server/auth'
import { getAgentDispatcher } from '../../../src/server/agent-dispatch-wiring'

export async function POST(request: NextRequest) {
  if (!(await requireOperator(request))) {
    return NextResponse.json({ ok: false, error: 'OPERATOR_AUTH_REQUIRED' }, { status: 401 })
  }
  const { runId } = await engine.startRun()

  // AC-3: dispatch invocation A to the deployed agent when configured.
  // The deterministic engine remains the source of truth for console
  // state; the agent's live run is the deployed surface.
  const dispatcher = getAgentDispatcher()
  let agent: Record<string, unknown> | undefined
  if (dispatcher.isEnabled()) {
    const dispatched = await dispatcher.dispatch({ kind: 'decision-run', sessionId: runId })
    agent = { ok: dispatched.ok, transport: dispatched.dispatch.transport, result: dispatched.result, error: dispatched.error }
  }

  return NextResponse.json({ ok: true, runId, agent })
}
