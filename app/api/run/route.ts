import { NextResponse } from 'next/server'
import engine from '../../../src/server/state'

export async function POST() {
  const { runId } = await engine.startRun()
  return NextResponse.json({ ok: true, runId })
}
