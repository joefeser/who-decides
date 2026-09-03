import { NextResponse } from 'next/server'
import engine from '../../../src/server/state'

export async function GET() {
  return NextResponse.json(engine.getState())
}

/** Demo reset: clears run state (durable records for completed runs remain in
 *  .tmp artifacts and the consumption db keeps its claims — replay protection
 *  is never reset; only the console view starts over). */
export async function DELETE() {
  engine.reset()
  return NextResponse.json({ ok: true })
}
