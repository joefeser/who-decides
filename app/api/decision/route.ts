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
  // The dispatch carries the AUTHORITATIVE stored decision — on an
  // idempotent retry the request body may carry a different rationale,
  // but the recorded one is what was consumed (review P1).
  const dispatcher = getAgentDispatcher()
  let agent: Record<string, unknown> | undefined
  if (dispatcher.isEnabled()) {
    const state = await engine.getState()
    if (state.decision) {
      const dispatched = await dispatcher.dispatch({
        kind: 'decision-resume',
        sessionId: state.runId,
        choice: state.decision.choice,
        rationale: state.decision.rationale,
      })
      agent = { ok: dispatched.ok, transport: dispatched.dispatch.transport, result: dispatched.result, error: dispatched.error }
    }
  }

  return NextResponse.json({ ...result, agent })
}
