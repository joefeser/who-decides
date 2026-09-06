import { NextRequest, NextResponse } from 'next/server'
import engine from '../../../src/server/state'
import { requireOperator } from '../../../src/server/auth'

/** Watch mode: the state itself is public; `authenticated` tells the console
 * whether to render operator affordances (run/decide/reset/probe). */
export async function GET(request: NextRequest) {
  const state = await engine.getState()
  return NextResponse.json({ ...state, authenticated: await requireOperator(request) })
}

/** Demo reset: clears run state (durable records for completed runs remain in
 *  .tmp artifacts and the consumption db keeps its claims — replay protection
 *  is never reset; only the console view starts over). OPERATOR ONLY. */
export async function DELETE(request: NextRequest) {
  if (!(await requireOperator(request))) {
    return NextResponse.json({ ok: false, error: 'OPERATOR_AUTH_REQUIRED' }, { status: 401 })
  }
  await engine.reset()
  return NextResponse.json({ ok: true })
}
