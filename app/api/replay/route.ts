import { NextResponse } from 'next/server'
import engine from '../../../src/server/state'

/** Duplicate-resume probe: a second invocation attempts to claim the same
 *  decision. It must fail closed — shown in the console as proof. */
export async function POST() {
  try {
    const probe = engine.attemptDuplicateReplay()
    return NextResponse.json({ ok: true, probe })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ ok: false, error: message }, { status: 409 })
  }
}
