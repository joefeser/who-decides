import { NextRequest, NextResponse } from 'next/server'
import engine from '../../../src/server/state'
import { requireOperator } from '../../../src/server/auth'

/** Duplicate-resume probe: a second invocation attempts to claim the same
 *  decision. It must fail closed — shown in the console as proof. */
export async function POST(request: NextRequest) {
  if (!(await requireOperator(request))) {
    return NextResponse.json({ ok: false, error: 'OPERATOR_AUTH_REQUIRED' }, { status: 401 })
  }
  try {
    const probe = await engine.attemptDuplicateReplay()
    return NextResponse.json({ ok: true, probe })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ ok: false, error: message }, { status: 409 })
  }
}
