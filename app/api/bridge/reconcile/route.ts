import { NextRequest, NextResponse } from 'next/server'
import { requireOperatorSession } from '../../../../src/server/auth'
import { privateEvidenceEnabled } from '../../../../src/server/evidence-access'
import engine from '../../../../src/server/state'

/** Observe a human reopen. This never calls reopen or answers a card. */
export async function POST(request: NextRequest) {
  if (!privateEvidenceEnabled()) return NextResponse.json({ error: 'LOCAL_PROFILE_REQUIRED' }, { status: 404 })
  if (!(await requireOperatorSession(request))) return NextResponse.json({ error: 'OPERATOR_AUTH_REQUIRED' }, { status: 401 })
  const body = await request.json().catch(() => null)
  if (typeof body?.runId !== 'string' || !body.runId || body.runId.length > 128) return NextResponse.json({ error: 'INVALID_RUN_ID' }, { status: 400 })
  try { return NextResponse.json(await engine.observeReopenedDecision(body.runId)) }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'REOPEN_OBSERVATION_FAILED' }, { status: 409 }) }
}
