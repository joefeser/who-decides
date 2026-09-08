import { NextRequest, NextResponse } from 'next/server'
import engine from '../../../src/server/state'
import { requireOperator } from '../../../src/server/auth'
import { getAgentDispatcher, agentDispatcherError } from '../../../src/server/agent-dispatch-wiring'

export async function POST(request: NextRequest) {
  if (!(await requireOperator(request))) {
    return NextResponse.json({ ok: false, error: 'OPERATOR_AUTH_REQUIRED' }, { status: 401 })
  }
  const dispatcher = getAgentDispatcher()
  if (agentDispatcherError()) return NextResponse.json({ ok: false, error: 'AGENT_DISPATCH_UNAVAILABLE' }, { status: 503 })
  const { runId } = await engine.startRun(false, dispatcher)
  const result = await engine.dispatchStart(runId, dispatcher)
  return NextResponse.json({ ...result, runId }, { status: result.ok ? 200 : 409 })
}
