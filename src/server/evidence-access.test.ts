import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NextRequest } from 'next/server'
import { privateEvidenceEnabled, validatePrivateLocalConfig } from './evidence-access'
import { loginOperator, OPERATOR_COOKIE_NAME, resetSessionsForTests, sha256Hex } from './auth'
import { GET as readState } from '../../app/api/state/route'
import { GET as readArtifact } from '../../app/api/artifacts/[name]/route'

test('invalid evidence profile fails closed', () => {
  assert.equal(privateEvidenceEnabled({}), false)
  assert.equal(privateEvidenceEnabled({ WD_PROFILE: 'private-local' }), true)
  assert.throws(() => privateEvidenceEnabled({ WD_PROFILE: 'private' }))
})

test('private routes authenticate before accessing state or artifact identifiers', async () => {
  const original = { ...process.env }
  const dir = mkdtempSync(join(tmpdir(), 'wd-private-evidence-'))
  try {
    process.env.WD_PROFILE = 'private-local'
    process.env.WD_CONSOLE_DIR = dir
    process.env.WD_OPERATOR_PASSCODE_HASH = sha256Hex('synthetic-local-operator')
    resetSessionsForTests()
    const request = new Request('http://localhost:3100/api/state') as NextRequest
    assert.equal((await readState(request)).status, 401)
    // A denied request must not inspect NextRequest-specific URL fields.
    assert.equal((await readArtifact(request, { params: Promise.resolve({ name: 'secret' }) })).status, 401)
    const login = await loginOperator('synthetic-local-operator')
    assert.equal(login.ok, true)
    if (!login.ok) throw new Error('fixture sign-in failed')
    const authenticated = new Request(request.url, {
      headers: { cookie: `${OPERATOR_COOKIE_NAME}=${login.token}` },
    }) as NextRequest
    assert.equal((await readState(authenticated)).status, 200)
    resetSessionsForTests()
    assert.equal((await readState(authenticated)).status, 200)
    process.env.WD_OPERATOR_PASSCODE_HASH = sha256Hex('rotated-operator')
    assert.equal((await readState(authenticated)).status, 401)
  } finally {
    resetSessionsForTests()
    process.env = original
    rmSync(dir, { recursive: true, force: true })
  }
})

test('private setup refuses hosted backends and missing operator identity', () => {
  assert.throws(() => validatePrivateLocalConfig({ WD_PROFILE: 'private-local' }))
  const local = { WD_PROFILE: 'private-local', WD_OPERATOR_PASSCODE_HASH: sha256Hex('synthetic') }
  assert.doesNotThrow(() => validatePrivateLocalConfig(local))
  assert.throws(() => validatePrivateLocalConfig({ ...local, WD_STORE: 'postgres' }))
  assert.throws(() => validatePrivateLocalConfig({ ...local, WD_AGENTCORE_ENDPOINT: 'hosted' }))
})
