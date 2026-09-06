import { NextRequest, NextResponse } from 'next/server'
import engine from '../../../src/server/state'
import { requireOperator } from '../../../src/server/auth'

export async function POST(request: NextRequest) {
  if (!(await requireOperator(request))) {
    return NextResponse.json({ ok: false, error: 'OPERATOR_AUTH_REQUIRED' }, { status: 401 })
  }
  const { runId } = await engine.startRun()
  return NextResponse.json({ ok: true, runId })
}
