import { NextRequest, NextResponse } from 'next/server'
import { OPERATOR_COOKIE_CLEARED, readOperatorCookie, revokeOperatorSession } from '../../../../src/server/auth'

export async function POST(request: NextRequest) {
  await revokeOperatorSession(readOperatorCookie(request))
  return NextResponse.json({ ok: true }, { headers: { 'Set-Cookie': OPERATOR_COOKIE_CLEARED } })
}
