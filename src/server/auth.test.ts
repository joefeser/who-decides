/* Operator auth gate tests: passcode login, cookie issuance, mutation-route
 * guards, revoke/expiry, and the login rate limit. These exercise the real
 * Next.js route handlers, so WD_CONSOLE_DIR is bound to a scratch directory
 * BEFORE the route modules (and the engine singleton) are imported.
 * Run: npm run test:auth */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'

const DIR = mkdtempSync(path.join(tmpdir(), 'wd-auth-test-'))
process.env.WD_CONSOLE_DIR = DIR

const { OPERATOR_COOKIE_NAME, loginRateLimiter, resetSessionsForTests, sha256Hex } = await import('./auth')
const loginRoute = await import('../../app/api/operator/login/route')
const logoutRoute = await import('../../app/api/operator/logout/route')
const runRoute = await import('../../app/api/run/route')
const decisionRoute = await import('../../app/api/decision/route')
const stateRoute = await import('../../app/api/state/route')

const PASSCODE = 'demo-operator-passcode'

type Handler = (request: Request) => Promise<Response>
const postLogin = loginRoute.POST as unknown as Handler
const postLogout = logoutRoute.POST as unknown as Handler
const postRun = runRoute.POST as unknown as Handler
const postDecision = decisionRoute.POST as unknown as Handler
const postState = stateRoute.DELETE as unknown as Handler
const getState = stateRoute.GET as unknown as Handler

function loginRequest(body: unknown, ip = '203.0.113.7'): Request {
  return new Request('http://localhost/api/operator/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  })
}

function runRequest(cookie?: string): Request {
  return new Request('http://localhost/api/run', {
    method: 'POST',
    ...(cookie ? { headers: { cookie } } : {}),
  })
}

function cookieFrom(response: Response): string {
  const setCookie = response.headers.get('set-cookie')
  assert.ok(setCookie, 'login response sets a cookie')
  return setCookie.split(';')[0]!
}

async function login(ip?: string): Promise<string> {
  const response = await postLogin(loginRequest({ passcode: PASSCODE }, ip))
  assert.equal(response.status, 200)
  return cookieFrom(response)
}

before(() => {
  process.env.WD_OPERATOR_PASSCODE_HASH = sha256Hex(PASSCODE)
})

after(async () => {
  delete process.env.WD_OPERATOR_PASSCODE_HASH
  delete process.env.WD_CONSOLE_DIR
  loginRateLimiter.reset()
  resetSessionsForTests()
  rmSync(DIR, { recursive: true, force: true })
})

test('a wrong passcode is rejected with 401 OPERATOR_AUTH_REQUIRED', async () => {
  loginRateLimiter.reset()
  const response = await postLogin(loginRequest({ passcode: 'wrong-passcode' }))
  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), { ok: false, error: 'OPERATOR_AUTH_REQUIRED' })
})

test('a correct passcode logs in and sets the operator cookie; only the token hash is stored', async () => {
  loginRateLimiter.reset()
  const response = await postLogin(loginRequest({ passcode: PASSCODE }))
  assert.equal(response.status, 200)
  const cookie = response.headers.get('set-cookie')!
  assert.match(cookie, new RegExp(`^${OPERATOR_COOKIE_NAME}=[0-9a-f]{64}`))
  for (const attr of ['Secure', 'HttpOnly', 'SameSite=Strict', 'Path=/']) {
    assert.ok(cookie.includes(attr), `cookie carries ${attr}`)
  }
  const db = new Database(path.join(DIR, 'state.db'))
  const rows = db.prepare('SELECT token_hash FROM operator_sessions').all() as Array<{ token_hash: string }>
  db.close()
  assert.equal(rows.length, 1, 'exactly one session row')
  assert.match(rows[0]!.token_hash, /^[0-9a-f]{64}$/, 'only a sha256 hex hash is stored')
  assert.notEqual(rows[0]!.token_hash, sha256Hex(PASSCODE), 'the stored hash is the token hash, not the passcode hash')
})

test('mutation routes reject requests without a session cookie', async () => {
  loginRateLimiter.reset()
  for (const [name, response] of [
    ['POST /api/run', await postRun(runRequest())],
    ['DELETE /api/state', await postState(new Request('http://localhost/api/state', { method: 'DELETE' }))],
  ] as const) {
    assert.equal(response.status, 401, `${name} is guarded`)
    assert.deepEqual(await response.json(), { ok: false, error: 'OPERATOR_AUTH_REQUIRED' })
  }
})

test('a valid session passes the guards and watch mode reports authenticated', async () => {
  loginRateLimiter.reset()
  const cookie = await login()
  const run = await postRun(runRequest(cookie))
  assert.equal(run.status, 200)
  const runBody = await run.json() as { ok: boolean, runId: string }
  assert.equal(runBody.ok, true)
  assert.match(runBody.runId, /^run-/)
  const watcher = await getState(new Request('http://localhost/api/state'))
  const watcherBody = await watcher.json() as { authenticated: boolean }
  assert.equal(watcherBody.authenticated, false, 'GET /api/state stays public and reports visitors as unauthenticated')
  const operator = await getState(new Request('http://localhost/api/state', { headers: { cookie } }))
  assert.equal((await operator.json() as { authenticated: boolean }).authenticated, true)
})

test('a revoked session is rejected', async () => {
  loginRateLimiter.reset()
  const cookie = await login()
  const logout = await postLogout(new Request('http://localhost/api/operator/logout', {
    method: 'POST',
    headers: { cookie },
  }))
  assert.equal(logout.status, 200)
  assert.match(logout.headers.get('set-cookie')!, /Max-Age=0/, 'logout clears the cookie')
  const response = await postRun(runRequest(cookie))
  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), { ok: false, error: 'OPERATOR_AUTH_REQUIRED' })
})

test('an expired session is rejected', async () => {
  loginRateLimiter.reset()
  const cookie = await login()
  const db = new Database(path.join(DIR, 'state.db'))
  db.prepare("UPDATE operator_sessions SET expires_at = '2020-01-01T00:00:00.000Z'").run()
  db.close()
  const response = await postRun(runRequest(cookie))
  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), { ok: false, error: 'OPERATOR_AUTH_REQUIRED' })
})

test('five failed logins trip the rate limit for the IP', async () => {
  loginRateLimiter.reset()
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await postLogin(loginRequest({ passcode: `wrong-${attempt}` }))
    assert.equal(response.status, 401, `failure ${attempt + 1} still returns 401`)
  }
  // Even the CORRECT passcode is refused while the IP is blocked.
  const blocked = await postLogin(loginRequest({ passcode: PASSCODE }))
  assert.equal(blocked.status, 429)
  assert.deepEqual(await blocked.json(), { ok: false, error: 'RATE_LIMITED' })
  // A different IP is not affected by the first IP's failures.
  const otherIp = await postLogin(loginRequest({ passcode: PASSCODE }, '198.51.100.9'))
  assert.equal(otherIp.status, 200, 'rate limiting is per client IP')
})

test('the rate-limit identity is the LAST forwarded address, not the client-supplied first', async () => {
  loginRateLimiter.reset()
  const { clientIp } = await import('./auth')
  const forwarded = new Request('http://localhost/api/operator/login', {
    headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' },
  })
  assert.equal(clientIp(forwarded), '5.6.7.8', 'leftmost XFF values are client-controlled; the nearest proxy appends the real IP')
  // A client cannot spread failures by varying its own spoofed prefix: two
  // requests with different first values but the same last value share one
  // limiter identity.
  const first = new Request('http://localhost/api/operator/login', { headers: { 'x-forwarded-for': 'fake-a, 9.9.9.9' } })
  const second = new Request('http://localhost/api/operator/login', { headers: { 'x-forwarded-for': 'fake-b, 9.9.9.9' } })
  assert.equal(clientIp(first), clientIp(second))
})

test('removing or corrupting the passcode hash fails existing sessions closed', async () => {
  loginRateLimiter.reset()
  const cookie = await login()
  assert.equal((await postRun(runRequest(cookie))).status, 200, 'sanity: valid session before the config breaks')
  process.env.WD_OPERATOR_PASSCODE_HASH = 'not-a-real-hash'
  const corrupted = await postRun(runRequest(cookie))
  assert.equal(corrupted.status, 401, 'a malformed hash invalidates ISSUED sessions too')
  assert.equal((await postLogin(loginRequest({ passcode: PASSCODE }))).status, 401, 'a malformed hash also blocks new logins')
  delete process.env.WD_OPERATOR_PASSCODE_HASH
  const removed = await postRun(runRequest(cookie))
  assert.equal(removed.status, 401, 'an unset hash invalidates ISSUED sessions too')
  process.env.WD_OPERATOR_PASSCODE_HASH = sha256Hex(PASSCODE)
  assert.equal((await postRun(runRequest(cookie))).status, 200, 'restoring the config re-enables the still-valid session')
})

test('login works on a fresh console directory that does not exist yet', async () => {
  loginRateLimiter.reset()
  const freshRoot = mkdtempSync(path.join(tmpdir(), 'wd-auth-fresh-'))
  const freshDir = path.join(freshRoot, 'console', 'nested')
  process.env.WD_CONSOLE_DIR = freshDir
  resetSessionsForTests()
  try {
    const response = await postLogin(loginRequest({ passcode: PASSCODE }, '198.51.100.10'))
    assert.equal(response.status, 200, 'session storage initializes its own directory')
    const followup = await postRun(runRequest(cookieFrom(response)))
    assert.equal(followup.status, 200, 'the issued session passes the guards')
  } finally {
    process.env.WD_CONSOLE_DIR = DIR
    resetSessionsForTests()
    rmSync(freshRoot, { recursive: true, force: true })
  }
})

test('rotating the passcode invalidates sessions issued under the old passcode', async () => {
  loginRateLimiter.reset()
  const oldCookie = await login()
  assert.equal((await postRun(runRequest(oldCookie))).status, 200, 'sanity: valid before rotation')
  const rotatedPasscode = 'rotated-passcode-value'
  process.env.WD_OPERATOR_PASSCODE_HASH = sha256Hex(rotatedPasscode)
  try {
    const stale = await postRun(runRequest(oldCookie))
    assert.equal(stale.status, 401, 'old-credential session is dead after rotation')
    assert.deepEqual(await stale.json(), { ok: false, error: 'OPERATOR_AUTH_REQUIRED' })
    const reLogin = await postLogin(loginRequest({ passcode: rotatedPasscode }, '198.51.100.11'))
    assert.equal(reLogin.status, 200, 'the NEW passcode logs in under the rotated hash')
  } finally {
    process.env.WD_OPERATOR_PASSCODE_HASH = sha256Hex(PASSCODE)
  }
})

test('an authenticated decision records operator session metadata, not the unauthenticated demo default', async () => {
  loginRateLimiter.reset()
  const cookie = await login()
  const run = await postRun(runRequest(cookie))
  assert.equal(run.status, 200)
  // Age the wall-clock phase so the run reaches decision_required.
  const db = new Database(path.join(DIR, 'state.db'))
  db.prepare('UPDATE runs SET phase_changed_at = ?').run(new Date(Date.now() - 60_000).toISOString())
  db.close()
  const decision = await postDecision(new Request('http://localhost/api/decision', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ choice: 'defer', rationale: 'audit metadata check', idempotencyKey: 'auth-meta-test' }),
  }))
  assert.equal(decision.status, 200, `decision submits under a valid session: ${JSON.stringify(await decision.json().catch(() => null))}`)
  const artifactDb = new Database(path.join(DIR, 'state.db'))
  const row = artifactDb.prepare("SELECT json FROM artifacts WHERE name = 'human-decision' ORDER BY rowid DESC LIMIT 1").get() as { json: string }
  artifactDb.close()
  const artifact = JSON.parse(row.json) as { actor: { authentication_context: { session_reference: string, auth_event_ref: string } } }
  const context = artifact.actor.authentication_context
  assert.match(context.session_reference, /^op-session-[0-9a-f]{16}$/, 'session reference is the hash-prefix session id')
  assert.notEqual(context.session_reference, 'demo-unauthenticated-local-console')
  assert.match(context.auth_event_ref, /^op-passcode-login:/, 'auth event ref records the login timestamp')
})
