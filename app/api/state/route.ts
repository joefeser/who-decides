import { NextRequest, NextResponse } from 'next/server'
import engine from '../../../src/server/state'
import { agentDispatcherError } from '../../../src/server/agent-dispatch-wiring'
import { requireOperator } from '../../../src/server/auth'

/** Watch mode: the state itself is public; `authenticated` tells the console
 * whether to render operator affordances (run/decide/reset/probe). */
export async function GET(request: NextRequest) {
  const state = await engine.getState()
  // Health surface: a configured-but-failed dispatcher startup (SDK missing)
  // is visible here, not silent (review P2). Pretty-printed so a judge
  // curling the watch surface can read the same state the page renders.
  const payload = { ...state, authenticated: await requireOperator(request), agentDispatchError: agentDispatcherError()?.message ?? null }
  return new NextResponse(JSON.stringify(payload, null, 2), {
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

/** Demo reset: clears run state (durable records for completed runs remain in
 *  .tmp artifacts and the consumption db keeps its claims — replay protection
 *  is never reset; only the console view starts over). OPERATOR ONLY. */
export async function DELETE(request: NextRequest) {
  if (!(await requireOperator(request))) {
    return NextResponse.json({ ok: false, error: 'OPERATOR_AUTH_REQUIRED' }, { status: 401 })
  }
  try {
    await engine.reset()
    return NextResponse.json({ ok: true })
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : 'RESET_FAILED' }, { status: 409 })
  }
}
