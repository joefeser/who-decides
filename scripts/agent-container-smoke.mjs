// Tests the packaged Linux ARM64 artifact without AWS credentials or model calls.
import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
const image = process.env.WD_AGENT_IMAGE ?? 'who-decides:ac5-repair'
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim()
const native = docker('run', '--rm', '--platform', 'linux/arm64', '--entrypoint', 'node', image, '-e', `
  const assert = require('node:assert/strict');
  assert.equal(process.versions.node.split('.')[0], '22');
  assert.equal(process.arch, 'arm64');
  const db = new (require('better-sqlite3'))(':memory:');
  assert.equal(db.prepare('SELECT 1 AS ok').get().ok, 1);
  db.close();
  console.log('Node 22 ARM64 native SQLite passed');
`)
console.log(native)
const name = `wd-agent-smoke-${randomUUID()}`
let started = false
try {
  docker('run', '--rm', '-d', '--platform', 'linux/arm64', '--name', name, '-p', '127.0.0.1::8080', image)
  started = true
  const address = docker('port', name, '8080/tcp').split('\n')[0]
  const base = `http://${address}`
  let ping
  for (let attempt = 0; attempt < 40; attempt++) {
    try { ping = await fetch(`${base}/ping`, { signal: AbortSignal.timeout(1000) }); if (ping.ok) break } catch {}
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  assert.equal(ping?.status, 200, 'packaged service must boot')
  assert.equal((await ping.json()).status, 'Healthy')
  const denied = await fetch(`${base}/invocations`, { method: 'POST', body: JSON.stringify({ kind: 'decision-run', sessionId: 'smoke-only' }) })
  assert.equal(denied.status, 503)
  assert.equal((await denied.json()).error, 'MACHINE_AUTH_DISABLED')
  console.log('Packaged /ping and fail-closed /invocations passed; no AWS/model calls')
} finally {
  if (started) { try { docker('stop', name) } catch { /* The --rm container may already have exited. */ } }
}
