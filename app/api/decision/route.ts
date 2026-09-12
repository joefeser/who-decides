import { NextRequest, NextResponse } from 'next/server'
import engine from '../../../src/server/state'
import { requireOperatorSession } from '../../../src/server/auth'
import { getAgentDispatcher } from '../../../src/server/agent-dispatch-wiring'

export async function POST(request: NextRequest) {
  const session = await requireOperatorSession(request)
  if (!session) {
    return NextResponse.json({ ok: false, error: 'OPERATOR_AUTH_REQUIRED' }, { status: 401 })
  }
  const body = (await request.json().catch(() => null)) as { runId?: string, choice?: string, rationale?: string, idempotencyKey?: string } | null
  if (!body || typeof body.runId !== 'string' || !body.runId || typeof body.choice !== 'string' || typeof body.rationale !== 'string' || (body.idempotencyKey !== undefined && typeof body.idempotencyKey !== 'string')) {
    return NextResponse.json({ ok: false, error: 'VALIDATION_ERROR' }, { status: 400 })
  }
  const result = await engine.submitDecision(body.choice, body.rationale, body.idempotencyKey, session, body.runId, getAgentDispatcher())
  return NextResponse.json(result, { status: result.ok ? 200 : 409 })
}
