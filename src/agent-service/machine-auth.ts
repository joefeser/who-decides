/* Machine-principal authentication for the agent service (AC-2, #18).
 *
 * The agent runtime authenticates as its OWN principal type — a scoped
 * service token, distinct from operator passcodes, never impersonating an
 * operator session (the #49 disposition's "separately governed approval
 * act" pattern at the console layer). The token travels in the
 * Authorization header as `Bearer <token>`; validation is timing-safe
 * against a sha256 of the configured secret; unknown principal types fail
 * closed with a typed 401.
 *
 * The artifacts record the channel honestly: interaction 'api',
 * sessionReference 'machine:agentcore-runtime', authEventRef
 * 'machine-service-token' — a verifiable machine principal, never
 * 'operator-session'. */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export const MACHINE_PRINCIPAL = 'machine:agentcore-runtime' as const

export type MachineAuthConfig = {
  /** sha256 hex of the service token. Generated with:
   *  echo -n "$TOKEN" | shasum -a 256
   * Configured via WD_MACHINE_TOKEN_HASH; absent = machine auth disabled
   * (the service refuses all invocations — fail closed, not open). */
  tokenHash: string | undefined
}

export type MachinePrincipal = {
  type: 'machine'
  principal: typeof MACHINE_PRINCIPAL
  /** Stable reference for artifacts — a hash prefix of the configured
   * credential, never the credential itself. */
  credentialRef: string
}

export type MachineAuthResult =
  | { ok: true, principal: MachinePrincipal }
  | { ok: false, error: 'MACHINE_AUTH_DISABLED' | 'MACHINE_AUTH_REQUIRED' | 'MACHINE_AUTH_INVALID' }

function isSha256Hex(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value)
}

export function createMachineAuth(config: MachineAuthConfig) {
  const configured = config.tokenHash !== undefined && isSha256Hex(config.tokenHash)

  return {
    /** Whether the service can accept invocations at all. When the hash is
     * absent or malformed, every invocation fails closed. */
    isEnabled(): boolean {
      return configured
    },

    /** Validate a bare credential string (the managed-runtime payload path:
     * the platform delivers invocation bodies, not Authorization headers).
     * Same validation, same principal, same typed errors. */
    authorizeCredential(credential: string): MachineAuthResult {
      if (!configured) return { ok: false, error: 'MACHINE_AUTH_DISABLED' }
      const supplied = createHash('sha256').update(credential).digest()
      const expected = Buffer.from(config.tokenHash!, 'hex')
      if (!timingSafeEqual(supplied, expected)) return { ok: false, error: 'MACHINE_AUTH_INVALID' }
      return {
        ok: true,
        principal: { type: 'machine', principal: MACHINE_PRINCIPAL, credentialRef: `machine-token-${config.tokenHash!.slice(0, 16)}` },
      }
    },

    /** Validate a request's Authorization header. Accepts either a Fetch
     * Request or a Node IncomingMessage (whose headers are a plain object
     * without .get — the review P1: the cast made every invocation throw
     * before the error handler). */
    authorize(request: { headers: { get(name: string): string | null } } | { headers: Record<string, string | string[] | undefined> }): MachineAuthResult {
      if (!configured) return { ok: false, error: 'MACHINE_AUTH_DISABLED' }
      const raw = typeof (request.headers as { get?: unknown }).get === 'function'
        ? (request.headers as { get(name: string): string | null }).get('authorization')
        : (request.headers as Record<string, string | string[] | undefined>).authorization
      const header = Array.isArray(raw) ? raw[0] ?? '' : raw ?? ''
      const match = /^Bearer\s+(.+)$/i.exec(header)
      if (!match) return { ok: false, error: 'MACHINE_AUTH_REQUIRED' }
      const supplied = createHash('sha256').update(match[1]!).digest()
      const expected = Buffer.from(config.tokenHash!, 'hex')
      if (!timingSafeEqual(supplied, expected)) return { ok: false, error: 'MACHINE_AUTH_INVALID' }
      return {
        ok: true,
        principal: {
          type: 'machine',
          principal: MACHINE_PRINCIPAL,
          credentialRef: `machine-token-${config.tokenHash!.slice(0, 16)}`,
        },
      }
    },

  }
}

/** Generate a token + its hash for provisioning (PROVISION.md uses this to
 * show operators how to mint credentials). */
export function generateMachineToken(): { token: string, tokenHash: string } {
  const token = randomBytes(32).toString('hex')
  return { token, tokenHash: createHash('sha256').update(token).digest('hex') }
}

export type MachineAuth = ReturnType<typeof createMachineAuth>

/** The only way to construct a MachinePrincipalAttestation — server code
 * calls this AFTER authorize() returns ok, making fabricated references
 * from phase callers structurally impossible (review security finding). */
/** The private brand — declared here and nowhere else. A direct phase
 * caller cannot construct this object even with an identical-looking
 * shape: the Symbol property is unrepresentable outside this module. */
const ATTESTED: unique symbol = Symbol('machine-principal-attested')

export function attestMachinePrincipal(
  result: MachineAuthResult,
): import('../agent-core/types').MachinePrincipalAttestation | undefined {
  if (!result.ok) return undefined
  return { [ATTESTED]: true, credentialRef: result.principal.credentialRef } as unknown as import('../agent-core/types').MachinePrincipalAttestation
}

/** Runtime verification the phases call before trusting the attestation —
 * the truthiness check alone accepted structural forgeries (review P2). */
export function isAttestedMachinePrincipal(
  value: unknown,
): value is import('../agent-core/types').MachinePrincipalAttestation {
  return typeof value === 'object' && value !== null && ATTESTED in value && (value as Record<symbol, unknown>)[ATTESTED] === true
}
