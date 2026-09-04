import { NextRequest, NextResponse } from 'next/server'
import engine from '../../../src/server/state'

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as { choice?: string, rationale?: string, idempotencyKey?: string } | null
  if (!body?.choice || typeof body.rationale !== 'string') {
    return NextResponse.json({ ok: false, error: 'VALIDATION_ERROR' }, { status: 400 })
  }
  const result = await engine.submitDecision(body.choice, body.rationale, body.idempotencyKey)
  return NextResponse.json(result, { status: result.ok ? 200 : 409 })
}
