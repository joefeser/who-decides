import { NextRequest, NextResponse } from 'next/server'
import engine from '../../../../src/server/state'
import { requireOperator, requireOperatorSession } from '../../../../src/server/auth'

/** Production resume for a bridge run's outbound ops (review round 1, P2):
 * after a timeout or a corrected configuration, the operator re-drives the
 * run's unresolved ops through the CONFIGURED transport — exact persisted
 * payloads, existing outbox claim, newly confirmed ops get their records.
 * With body {"probe": true} the SAME route records a duplicate-resume
 * PROBE instead: all ops must already be resolved, the re-run must
 * re-execute nothing, and the verdict persists on the run's receipts
 * (console gate-proof, the bridge flavor of /api/replay). OPERATOR ONLY:
 * dispatch spends the bridge credential. */
export async function POST(request: NextRequest) {
  let runId: unknown
  let force = false
  let probe = false
  try {
    const body = await request.json() as { runId?: unknown, force?: unknown, probe?: unknown }
    runId = body.runId
    // Force is the runbook's separate dead-owner recovery step: only after
    // verifying the owning process is gone. The ordinary route never forces.
    force = body.force === true
    probe = body.probe === true
  } catch {
    return NextResponse.json({ ok: false, error: 'INVALID_BODY' }, { status: 400 })
  }
  if (typeof runId !== 'string' || runId.length === 0 || runId.length > 128) {
    return NextResponse.json({ ok: false, error: 'INVALID_RUN_ID' }, { status: 400 })
  }
  try {
    if (probe) {
      // The probe is attributed to the REAL operator session, not just the
      // boolean gate — fail closed without one.
      const session = await requireOperatorSession(request)
      if (!session) {
        return NextResponse.json({ ok: false, error: 'OPERATOR_AUTH_REQUIRED' }, { status: 401 })
      }
      const probeResult = await engine.probeBridgeDuplicateResume(runId, session.sessionReference)
      return NextResponse.json({ ok: true, probe: probeResult })
    }
    if (!(await requireOperator(request))) {
      return NextResponse.json({ ok: false, error: 'OPERATOR_AUTH_REQUIRED' }, { status: 401 })
    }
    const result = await engine.resumeBridgeOps(runId, force ? { force: true } : undefined)
    return NextResponse.json(result, { status: result.ok ? 200 : 409 })
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'RESUME_FAILED' },
      { status: 409 },
    )
  }
}
