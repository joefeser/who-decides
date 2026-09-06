import { NextRequest, NextResponse } from 'next/server'
import {
  clientIp, loginOperator, loginRateLimiter, operatorSessionCookie,
} from '../../../../src/server/auth'

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as { passcode?: string } | null
  if (!body?.passcode || typeof body.passcode !== 'string') {
    return NextResponse.json({ ok: false, error: 'VALIDATION_ERROR' }, { status: 400 })
  }
  const ip = clientIp(request)
  // Blocked IPs are refused before the passcode is even verified.
  if (loginRateLimiter.isBlocked(ip)) {
    return NextResponse.json({ ok: false, error: 'RATE_LIMITED' }, { status: 429 })
  }
  const result = await loginOperator(body.passcode)
  if (!result.ok) {
    loginRateLimiter.recordFailure(ip)
    return NextResponse.json({ ok: false, error: 'OPERATOR_AUTH_REQUIRED' }, { status: 401 })
  }
  loginRateLimiter.clear(ip)
  return NextResponse.json({ ok: true }, { headers: { 'Set-Cookie': operatorSessionCookie(result.token) } })
}
