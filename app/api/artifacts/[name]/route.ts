import { NextRequest, NextResponse } from 'next/server'
import engine from '../../../../src/server/state'

/** Watch-mode evidence surface: the persisted artifact JSON for the current
 * run, pretty-printed. Public by design — these are the receipts the demo
 * claims to show; a judge diffing them against the vendored schemas is the
 * intended use. Unknown names 404 rather than guessing.
 *
 * `?run=<id>` pins the request to the run the VIEWER is looking at: if the
 * server's current run differs (an operator reset and restarted during the
 * viewer's poll gap), the response is 409 RUN_CHANGED instead of serving the
 * new run's evidence under the old run's label (review: provenance). */
export async function GET(request: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params
  const expectedRun = request.nextUrl.searchParams.get('run')
  const artifact = await engine.getArtifact(name)
  if (artifact === undefined) {
    return NextResponse.json({ ok: false, error: 'ARTIFACT_NOT_FOUND' }, { status: 404 })
  }
  if (expectedRun !== null && expectedRun !== artifact.runId) {
    return NextResponse.json({ ok: false, error: 'RUN_CHANGED' }, { status: 409 })
  }
  return new NextResponse(JSON.stringify(JSON.parse(artifact.json), null, 2), {
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}
