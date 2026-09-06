import { NextRequest, NextResponse } from 'next/server'
import engine from '../../../src/server/state'
import { requireOperatorSession } from '../../../src/server/auth'
import { getAgentDispatcher } from '../../../src/server/agent-dispatch-wiring'

export async function POST(request: NextRequest) {
  const session = await requireOperatorSession(request)
  if (!session) {
    return NextResponse.json({ ok: false, error: 'OPERATOR_AUTH_REQUIRED' }, { status: 401 })
  }
  const body = (await request.json().catch(() => null)) as { choice?: string, rationale?: string, idempotencyKey?: string } | null
  if (!body?.choice || typeof body.rationale !== 'string') {
    return NextResponse.json({ ok: false, error: 'VALIDATION_ERROR' }, { status: 400 })
  }
  const result = await engine.submitDecision(body.choice, body.rationale, body.idempotencyKey, session)
  if (!result.ok) {
    return NextResponse.json(result, { status: 409 })
  }

  // AC-3: after the decision records locally, dispatch invocation B to the
  // deployed agent (the console's operator decision drives the live run).
  // The engine's result stands regardless of the agent's dispatch outcome.
  const dispatcher = getAgentDispatcher()
  let agent: Record<string, unknown> | undefined
  if (dispatcher.isEnabled()) {
    const state = await engine.getState()
    const dispatched = await dispatcher.dispatch({
      kind: 'decision-resume',
      sessionId: state.runId,
      choice: body.choice,
      rationale: body.rationale,
    })
    agent = { ok: dispatched.ok, transport: dispatched.dispatch.transport, result: dispatched.result, error: dispatched.error }
  }

  return NextResponse.json({ ...result, agent })
}
