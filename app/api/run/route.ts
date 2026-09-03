import { NextResponse } from 'next/server'
import engine from '../../../src/server/state.js'

export async function POST() {
  const { runId } = engine.startRun()
  return NextResponse.json({ ok: true, runId })
}
