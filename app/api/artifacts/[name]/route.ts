import { NextRequest, NextResponse } from 'next/server'
import engine from '../../../../src/server/state'

/** Watch-mode evidence surface: the persisted artifact JSON for the current
 * run, pretty-printed. Public by design — these are the receipts the demo
 * claims to show; a judge diffing them against the vendored schemas is the
 * intended use. Unknown names 404 rather than guessing. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params
  const json = await engine.getArtifact(name)
  if (json === undefined) {
    return NextResponse.json({ ok: false, error: 'ARTIFACT_NOT_FOUND' }, { status: 404 })
  }
  return new NextResponse(JSON.stringify(JSON.parse(json), null, 2), {
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}
