import { NextRequest, NextResponse } from 'next/server'
import engine from '../../../../src/server/state'
import { requireOperator } from '../../../../src/server/auth'

/** Production resume for a bridge run's outbound ops (review round 1, P2):
 * after a timeout or a corrected configuration, the operator re-drives the
 * run's unresolved ops through the CONFIGURED transport — exact persisted
 * payloads, existing outbox claim, newly confirmed ops get their records.
 * OPERATOR ONLY: dispatch spends the bridge credential. */
export async function POST(request: NextRequest) {
  if (!(await requireOperator(request))) {
    return NextResponse.json({ ok: false, error: 'OPERATOR_AUTH_REQUIRED' }, { status: 401 })
  }
  let runId: unknown
  try {
    const body = await request.json() as { runId?: unknown }
    runId = body.runId
  } catch {
    return NextResponse.json({ ok: false, error: 'INVALID_BODY' }, { status: 400 })
  }
  if (typeof runId !== 'string' || runId.length === 0 || runId.length > 128) {
    return NextResponse.json({ ok: false, error: 'INVALID_RUN_ID' }, { status: 400 })
  }
  try {
    const result = await engine.resumeBridgeOps(runId)
    return NextResponse.json(result, { status: result.ok ? 200 : 409 })
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'RESUME_FAILED' },
      { status: 500 },
    )
  }
}
