/* Route guard tests for POST /api/external/decisions (A1): typed
 * machine-auth failures and strict envelope rejection — every case here
 * stops BEFORE the engine is touched, so the route's guard behavior is
 * exercised without any engine state. Run: npm run test:bridge */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import type { NextRequest } from 'next/server'
import { POST } from '../../app/api/external/decisions/route'

const TOKEN = 'bridge-service-token-0123456789abcdef'
const HASH = createHash('sha256').update(TOKEN).digest('hex')

function post(body: unknown, authorization?: string): Promise<Response> {
  const request = new Request('http://localhost:3100/api/external/decisions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(authorization !== undefined ? { authorization } : {}),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
  return POST(request as unknown as NextRequest)
}

function validEnvelope(): Record<string, unknown> {
  return {
    schema: 'who-decides.decision-request.v0',
    sourceSystem: 'chopin',
    question: 'Approve the dependency upgrade implementation graph?',
    options: [{ id: 'approve' }, { id: 'send_back' }],
    coordination: { documentId: 'https://chopin.test/d/abc123', questionId: 'runtime-floor', revision: 7 },
    contextRefs: ['chopin:doc:abc123'],
    digests: [{ algorithm: 'sha256', value: 'a'.repeat(64) }],
  }
}

test('unset bridge hash disables the route (fail closed, typed 503)', async () => {
  const saved = process.env.WD_BRIDGE_TOKEN_HASH
  delete process.env.WD_BRIDGE_TOKEN_HASH
  try {
    const response = await post(validEnvelope(), `Bearer ${TOKEN}`)
    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), { ok: false, error: 'MACHINE_AUTH_DISABLED' })
  } finally {
    if (saved !== undefined) process.env.WD_BRIDGE_TOKEN_HASH = saved
  }
})

test('malformed bridge hash also fails closed', async () => {
  const saved = process.env.WD_BRIDGE_TOKEN_HASH
  process.env.WD_BRIDGE_TOKEN_HASH = 'not-hex'
  try {
    const response = await post(validEnvelope(), `Bearer ${TOKEN}`)
    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), { ok: false, error: 'MACHINE_AUTH_DISABLED' })
  } finally {
    if (saved !== undefined) process.env.WD_BRIDGE_TOKEN_HASH = saved
    else delete process.env.WD_BRIDGE_TOKEN_HASH
  }
})

test('missing and wrong bearer tokens are typed 401s', async () => {
  const saved = process.env.WD_BRIDGE_TOKEN_HASH
  process.env.WD_BRIDGE_TOKEN_HASH = HASH
  try {
    const missing = await post(validEnvelope())
    assert.equal(missing.status, 401)
    assert.deepEqual(await missing.json(), { ok: false, error: 'MACHINE_AUTH_REQUIRED' })

    const wrong = await post(validEnvelope(), 'Bearer wrong-token')
    assert.equal(wrong.status, 401)
    assert.deepEqual(await wrong.json(), { ok: false, error: 'MACHINE_AUTH_INVALID' })

    // The runtime principal's token must NOT open the bridge route: distinct
    // scoped credentials, one principal each.
    const crossUse = await post(validEnvelope(), `Bearer ${'b'.repeat(64)}`)
    assert.equal(crossUse.status, 401)
  } finally {
    if (saved !== undefined) process.env.WD_BRIDGE_TOKEN_HASH = saved
    else delete process.env.WD_BRIDGE_TOKEN_HASH
  }
})

test('a valid token cannot push an invalid envelope past the route', async () => {
  const saved = process.env.WD_BRIDGE_TOKEN_HASH
  process.env.WD_BRIDGE_TOKEN_HASH = HASH
  try {
    const smuggled = await post({ ...validEnvelope(), actor_id: 'joe' }, `Bearer ${TOKEN}`)
    assert.equal(smuggled.status, 400)
    const body = await smuggled.json() as { ok: boolean, error: string, details: string[] }
    assert.equal(body.error, 'ENVELOPE_INVALID')
    assert.ok(body.details.length > 0, 'rejection carries the validator errors')

    const malformed = await post('not json at all', `Bearer ${TOKEN}`)
    assert.equal(malformed.status, 400)
    assert.equal(((await malformed.json()) as { error: string }).error, 'ENVELOPE_INVALID')
  } finally {
    if (saved !== undefined) process.env.WD_BRIDGE_TOKEN_HASH = saved
    else delete process.env.WD_BRIDGE_TOKEN_HASH
  }
})
