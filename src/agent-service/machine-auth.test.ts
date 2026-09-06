/* Machine-principal auth tests (AC-2). Run: npm run test:machine-auth */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createMachineAuth, generateMachineToken, MACHINE_PRINCIPAL } from './machine-auth'

const TOKEN = 'test-service-token-0123456789abcdef'
const HASH = createHash('sha256').update(TOKEN).digest('hex')

function requestWith(auth?: string): Request {
  return new Request('http://localhost:8080/invocations', {
    method: 'POST',
    headers: auth !== undefined ? { authorization: auth } : {},
  })
}

test('valid service token authenticates as the machine principal', () => {
  const auth = createMachineAuth({ tokenHash: HASH })
  const result = auth.authorize(requestWith(`Bearer ${TOKEN}`))
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.principal.type, 'machine')
    assert.equal(result.principal.principal, MACHINE_PRINCIPAL)
    assert.match(result.principal.credentialRef, /^machine-token-[0-9a-f]{16}$/)
    // the credential itself never appears
    assert.ok(!JSON.stringify(result).includes(TOKEN))
  }
})

test('missing, malformed, and wrong tokens fail closed with typed errors', () => {
  const auth = createMachineAuth({ tokenHash: HASH })
  const a1 = auth.authorize(requestWith()); assert.equal(a1.ok, false); if (!a1.ok) assert.equal(a1.error, 'MACHINE_AUTH_REQUIRED')
  const a2 = auth.authorize(requestWith('Basic abc')); assert.equal(a2.ok, false); if (!a2.ok) assert.equal(a2.error, 'MACHINE_AUTH_REQUIRED')
  const a3 = auth.authorize(requestWith('Bearer wrong-token')); assert.equal(a3.ok, false); if (!a3.ok) assert.equal(a3.error, 'MACHINE_AUTH_INVALID')
  // timing-safe: the error is identical regardless of how wrong
  const a4 = auth.authorize(requestWith(`Bearer ${'x'.repeat(64)}`)); assert.equal(a4.ok, false); if (!a4.ok) assert.equal(a4.error, 'MACHINE_AUTH_INVALID')
})

test('absent or malformed hash disables the service (fail closed, not open)', () => {
  for (const bad of [undefined, 'not-hex', 'abc123']) {
    const auth = createMachineAuth({ tokenHash: bad })
    assert.equal(auth.isEnabled(), false)
    const a5 = auth.authorize(requestWith(`Bearer ${TOKEN}`)); assert.equal(a5.ok, false); if (!a5.ok) assert.equal(a5.error, 'MACHINE_AUTH_DISABLED')
  }
})

test('token generation produces a valid hash pair', () => {
  const { token, tokenHash } = generateMachineToken()
  assert.match(token, /^[0-9a-f]{64}$/)
  assert.equal(createHash('sha256').update(token).digest('hex'), tokenHash)
  // and the generated pair authenticates
  const auth = createMachineAuth({ tokenHash })
  assert.equal(auth.authorize(requestWith(`Bearer ${token}`)).ok, true)
})
