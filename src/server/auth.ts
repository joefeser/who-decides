/* Operator passcode gate — mutations are operator-only; /api/state stays
 * public for watch mode.
 *
 * Passcode verification: WD_OPERATOR_PASSCODE_HASH holds the sha256 hex of
 * the operator passcode. The candidate is hashed and compared timing-safe.
 * Missing or malformed hash FAILS CLOSED — every login and every guarded
 * route rejects while the env is unset. Generate the hash with:
 *
 *   printf '%s' 'choose-a-long-passcode' | sha256sum       # Linux
 *   printf '%s' 'choose-a-long-passcode' | shasum -a 256   # macOS
 *
 * (The passcode hash is a plain sha256 by contract — it protects a demo
 * console, and rotation is re-running the command. It is NOT a password
 * database; do not reuse a password you use elsewhere.)
 *
 * Sessions: a successful login returns a random 32-byte token ONCE; only
 * its sha256 is persisted, in the operator_sessions table of the console's
 * SQLite via the SessionStore seam. Session TTL is 12 hours. The browser
 * keeps the token in a Secure/HttpOnly/SameSite=Strict cookie — never in
 * localStorage.
 *
 * Login rate limit: 5 failed attempts per 15 minutes per client IP,
 * in-memory per process (fine for the single-process demo; Caddy fronts
 * the public deployment). A successful login clears that IP's failures. */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import path from 'node:path'
import { SqliteSessionStore } from './store/sqlite-session-store'
import type { SessionStore } from './store/store'

export const OPERATOR_COOKIE_NAME = 'wd_operator_session'
const SESSION_TTL_MS = 12 * 60 * 60 * 1000
const SESSION_TTL_SECONDS = SESSION_TTL_MS / 1000
const RATE_WINDOW_MS = 15 * 60 * 1000
const RATE_MAX_FAILURES = 5

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/** True only when WD_OPERATOR_PASSCODE_HASH is present and well-formed.
 * BOTH login and session validation gate on this — removing or corrupting
 * the env must shut the operator gate, not just future logins. */
export function passcodeConfigured(): boolean {
  return /^[0-9a-fA-F]{64}$/.test(process.env.WD_OPERATOR_PASSCODE_HASH ?? '')
}

export function verifyPasscode(candidate: string): boolean {
  // Fail closed on unset or malformed env; the shape guard also guarantees
  // both buffers are 32 bytes, so timingSafeEqual cannot throw on length.
  if (!passcodeConfigured()) return false
  const expected = process.env.WD_OPERATOR_PASSCODE_HASH!
  return timingSafeEqual(Buffer.from(sha256Hex(candidate), 'hex'), Buffer.from(expected, 'hex'))
}

/* Lazily-bound default store: WD_CONSOLE_DIR is read at first use, so tests
 * can bind a scratch directory before anything touches sessions. */
let cachedStore: SessionStore | undefined
function defaultSessionStore(): SessionStore {
  if (!cachedStore) {
    cachedStore = new SqliteSessionStore(process.env.WD_CONSOLE_DIR ?? path.resolve(process.cwd(), '.tmp/console'))
  }
  return cachedStore
}

/** Test seam: drop the cached store so a new WD_CONSOLE_DIR binds. */
export function resetSessionsForTests(): void {
  cachedStore?.close().catch(() => {})
  cachedStore = undefined
}

export type LoginResult = { ok: true, token: string } | { ok: false }

export async function loginOperator(candidate: string, store: SessionStore = defaultSessionStore()): Promise<LoginResult> {
  if (!verifyPasscode(candidate)) return { ok: false }
  const token = randomBytes(32).toString('hex')
  const now = Date.now()
  await store.createSession(sha256Hex(token), new Date(now).toISOString(), new Date(now + SESSION_TTL_MS).toISOString(), passcodeFingerprint())
  await store.purgeExpiredSessions(new Date(now).toISOString()).catch(() => { /* best-effort tidy */ })
  return { ok: true, token }
}

/** Domain-separated fingerprint of the CONFIGURED passcode hash — stored on
 * each session row so rotating the passcode (old hash -> new valid hash)
 * invalidates sessions issued under the old credential. Never the raw env
 * value. */
function passcodeFingerprint(): string {
  return sha256Hex(`wd-passcode-rotation:${process.env.WD_OPERATOR_PASSCODE_HASH ?? ''}`)
}

export async function isOperatorSessionValid(token: string | undefined, store: SessionStore = defaultSessionStore()): Promise<boolean> {
  return (await operatorSession(token, store)) !== null
}

export type OperatorSessionInfo = { sessionReference: string, authEventRef: string }

/** Resolve the operator session behind a request to SAFE audit metadata:
 * a hash-prefix session reference and the login event timestamp. Returns
 * null when anything fails closed (config missing/malformed/rotated, no
 * cookie, unknown/revoked/expired session). */
export async function requireOperatorSession(request: Request, store: SessionStore = defaultSessionStore()): Promise<OperatorSessionInfo | null> {
  return operatorSession(readOperatorCookie(request), store)
}

async function operatorSession(token: string | undefined, store: SessionStore): Promise<OperatorSessionInfo | null> {
  // Fail closed with the passcode config, not just at login: a hash that is
  // removed or corrupted mid-deployment must invalidate ISSUED sessions too
  // (they would otherwise stay valid for up to the full 12h TTL).
  if (!passcodeConfigured()) return null
  if (!token) return null
  const row = await store.getSession(sha256Hex(token))
  if (!row) return null
  // Passcode rotation: a session issued under a DIFFERENT valid hash is dead
  // even before its TTL. NULL fingerprints (pre-fingerprinting rows) are
  // refused — fail closed.
  if (row.passcode_fingerprint !== passcodeFingerprint()) return null
  if (row.expires_at <= new Date().toISOString()) return null
  return {
    sessionReference: `op-session-${row.token_hash.slice(0, 16)}`,
    authEventRef: `op-passcode-login:${row.created_at}`,
  }
}

export async function revokeOperatorSession(token: string | undefined, store: SessionStore = defaultSessionStore()): Promise<void> {
  if (!token) return
  await store.revokeSession(sha256Hex(token))
}

export function readOperatorCookie(request: Request): string | undefined {
  const header = request.headers.get('cookie')
  if (!header) return undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() === OPERATOR_COOKIE_NAME) return part.slice(eq + 1).trim()
  }
  return undefined
}

/** Guard for mutation routes: true only with a valid, unexpired session. */
export async function requireOperator(request: Request): Promise<boolean> {
  return isOperatorSessionValid(readOperatorCookie(request))
}

export function operatorSessionCookie(token: string): string {
  return `${OPERATOR_COOKIE_NAME}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_SECONDS}`
}

export const OPERATOR_COOKIE_CLEARED = `${OPERATOR_COOKIE_NAME}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`

/** Rate-limit identity for an untrusted request. The LEFTMOST
 * X-Forwarded-For value is client-controlled (any caller can send one), so
 * the LAST value is used — the nearest trusted proxy (Caddy) appends the
 * real client IP there. Direct exposure without a proxy yields no usable
 * identity and falls back to a single shared 'unknown' bucket, which is
 * the conservative direction for a limiter. */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for')
  if (forwarded) {
    const parts = forwarded.split(',').map(p => p.trim()).filter(p => p.length > 0)
    if (parts.length > 0) return parts[parts.length - 1]!
  }
  return request.headers.get('x-real-ip') ?? 'unknown'
}

/** In-memory sliding-window limiter: RATE_MAX_FAILURES failed logins per
 * RATE_WINDOW_MS per client IP. Reset only for tests. */
export class LoginRateLimiter {
  private readonly failures = new Map<string, number[]>()

  isBlocked(ip: string, now = Date.now()): boolean {
    return this.recent(ip, now).length >= RATE_MAX_FAILURES
  }

  recordFailure(ip: string, now = Date.now()): void {
    const recent = this.recent(ip, now)
    recent.push(now)
    this.failures.set(ip, recent)
  }

  clear(ip: string): void {
    this.failures.delete(ip)
  }

  reset(): void {
    this.failures.clear()
  }

  private recent(ip: string, now: number): number[] {
    const stamps = (this.failures.get(ip) ?? []).filter(t => now - t < RATE_WINDOW_MS)
    if (stamps.length === 0) this.failures.delete(ip)
    else this.failures.set(ip, stamps)
    return stamps
  }
}

export const loginRateLimiter = new LoginRateLimiter()
