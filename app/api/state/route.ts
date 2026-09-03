import { NextResponse } from 'next/server'
import engine from '../../../src/server/state.js'

export async function GET() {
  return NextResponse.json(engine.getState())
}
