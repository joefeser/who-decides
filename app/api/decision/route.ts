import { NextRequest, NextResponse } from 'next/server'
import engine from '../../../src/server/state.js'

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as { choice?: string, rationale?: string, idempotencyKey?: string } | null
  if (!body?.choice || typeof body.rationale !== 'string') {
    return NextResponse.json({ ok: false, error: 'VALIDATION_ERROR' }, { status: 400 })
  }
  const result = engine.submitDecision(body.choice, body.rationale)
  return NextResponse.json(result, { status: result.ok ? 200 : 409 })
}
