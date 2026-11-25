/** Synthetic, model-free HTTP proof. Run inside an OS egress sandbox (see runbook). */
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { createConnection } from 'node:net'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, openSync, closeSync, cpSync } from 'node:fs'
import path from 'node:path'

const hash = value => createHash('sha256').update(value).digest('hex')
const write = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
const read = file => JSON.parse(readFileSync(file, 'utf8'))
async function json(url, init = {}) {
  const response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(15_000) })
  const body = await response.json()
  assert.ok(response.ok, `HTTP ${response.status}: ${JSON.stringify(body)}`)
  return body
}
async function mcp(origin, token, name, args) {
  const body = await json(`${origin}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${token}`, origin, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }) })
  assert.ok(!body.error, JSON.stringify(body))
  return body.result
}
if (process.argv[2] === '--worker') {
  const file = process.argv[3]
  const config = read(file)
  if (!config.runId) {
    const intake = await json(`${config.wd}/api/external/decisions`, { method: 'POST', headers: { authorization: `Bearer ${config.intake}`, 'content-type': 'application/json' }, body: JSON.stringify(config.envelope) })
    config.runId = intake.runId
    write(file, config)
    console.log('worker: request retained; stopped at human gate')
  } else {
    const snapshot = await mcp(config.chopin, config.machine, 'read_coordination_snapshot', { id: config.envelope.coordination.documentId })
    const decision = snapshot.structuredContent.decisions.find(d => d.id === config.envelope.coordination.questionId)
    assert.equal(decision.status, 'answered')
    console.log('worker: restarted and observed settled decision')
  }
  process.exit(0)
}

const chopin = path.resolve(process.argv[2] ?? '')
assert.ok(process.argv[2], 'Pass the isolated Chopin checkout path')
const bun = process.env.LOCAL_PROOF_BUN
assert.ok(bun, 'Set LOCAL_PROOF_BUN to the pinned Bun 1.4.5 executable')
const wdRoot = process.cwd()
mkdirSync('.tmp', { recursive: true })
const dir = mkdtempSync(path.resolve('.tmp/private-local-proof-'))
const credentials = Object.fromEntries(['key', 'human', 'machine', 'intake', 'operator'].map(k => [k, randomBytes(32).toString('hex')]))
write(path.join(dir, 'secrets.json'), credentials)
const c = 'http://127.0.0.1:18798', w = 'http://127.0.0.1:13100', p = 'http://127.0.0.1:18799'
const children = new Set()
const baseEnv = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR ?? '/tmp', NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1' }
let sequence = 0
function launch(exe, args, cwd, env, label) {
  const fd = openSync(path.join(dir, `${++sequence}-${label}.log`), 'w', 0o600)
  const child = spawn(exe, args, { cwd, env: { ...baseEnv, ...env }, stdio: ['ignore', fd, fd] })
  closeSync(fd)
  child.done = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })))
  children.add(child)
  child.once('exit', () => children.delete(child))
  return child
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  const timer = setTimeout(() => child.kill('SIGKILL'), 8_000)
  await child.done
  clearTimeout(timer)
}
async function ready(origin, route, child) {
  for (let n = 0; n < 100; n++) {
    if (child.exitCode !== null || child.signalCode !== null) throw Error(`server exited; inspect logs in ${dir}`)
    try { const r = await fetch(origin + route, { signal: AbortSignal.timeout(500) }); if (r.status === 200 || r.status === 401) return } catch {}
    await new Promise(r => setTimeout(r, 100))
  }
  throw Error(`server readiness timed out; inspect logs in ${dir}`)
}
// Fail the proof if it was launched without the claimed OS egress restriction.
const egress = await new Promise(resolve => {
  const socket = createConnection({ host: '1.1.1.1', port: 443 })
  socket.setTimeout(1500)
  socket.once('connect', () => { socket.destroy(); resolve('allowed') })
  socket.once('error', error => resolve(error.code))
  socket.once('timeout', () => { socket.destroy(); resolve('timeout') })
})
assert.ok(['EPERM', 'EACCES'].includes(egress), `OS egress denial was not proven: ${egress}`)
write(path.join(dir, 'directory.json'), { workspaces: [{ name: 'local/proof', path: chopin, branch: 'dev' }], principals: [
  { id: 'operator', kind: 'human', secretHash: hash(credentials.human), workspaces: { 'local/proof': 'write' } },
  { id: 'bridge', kind: 'machine', secretHash: hash(credentials.machine), workspaces: { 'local/proof': 'write' } },
] })
let activeDir = dir
function startChopin() {
  return launch(bun, ['apps/server/src/main.ts'], chopin, {
    AUTH_MODE: 'offline', AGENT: 'off', BACKGROUND_JOBS: 'off', STORAGE_DRIVER: 'sqlite', SQLITE_PATH: path.join(activeDir, 'chopin.sqlite'),
    SESSION_ENCRYPTION_KEY: credentials.key, CHOPIN_OFFLINE_DIRECTORY: path.join(dir, 'directory.json'), SERVER_HOST: '127.0.0.1', PORT: '18798', APP_ORIGIN: c,
    EXTERNAL_COORDINATION: 'on', COORDINATION_APPROVERS: 'bridge',
  }, 'chopin')
}
function startWd() {
  return launch(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-H', '127.0.0.1', '-p', '13100'], wdRoot, {
    WD_PROFILE: 'private-local', WD_STORE: 'sqlite', WD_CONSOLE_DIR: path.join(activeDir, 'wd'), WD_OPERATOR_PASSCODE_HASH: hash(credentials.operator),
    WD_BRIDGE_TOKEN_HASH: hash(credentials.intake), WD_CHOPIN_URL: p, WD_CHOPIN_ORIGIN: p, WD_CHOPIN_TOKEN: credentials.machine,
  }, 'who-decides')
}
let dropAnswer = true, dropped = 0, answerCalls = 0
const answerPayloads = new Map()
const proxy = createServer(async (req, res) => {
  try {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const body = Buffer.concat(chunks)
    const message = JSON.parse(body)
    const answer = message.params?.name === 'answer_decision'
    if (answer) { answerCalls++; const key = message.params.arguments.idempotencyKey; const prior = answerPayloads.get(key); if (prior) assert.equal(body.toString(), prior); else answerPayloads.set(key, body.toString()) }
    const headers = { ...req.headers, host: new URL(c).host, origin: c }
    delete headers.connection
    const response = await fetch(c + req.url, { method: req.method, headers, body, redirect: 'error' })
    const data = Buffer.from(await response.arrayBuffer())
    if (answer && dropAnswer) { dropAnswer = false; dropped++; res.destroy(); return }
    res.writeHead(response.status, Object.fromEntries([...response.headers].filter(([k]) => !['connection', 'transfer-encoding', 'content-length', 'content-encoding'].includes(k))))
    res.end(data)
  } catch { res.destroy() }
})
let cs, ws
try {
  proxy.listen(18799, '127.0.0.1'); await once(proxy, 'listening')
  cs = startChopin(); ws = startWd()
  await Promise.all([ready(c, '/api/session', cs), ready(w, '/api/state', ws)])
  assert.equal((await fetch(w + '/api/state')).status, 401)
  assert.equal((await fetch(w + '/api/artifacts/decision-request')).status, 401)
  const bad = await fetch(c + '/mcp', { method: 'POST', headers: { authorization: 'Bearer invalid', origin: c, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })
  assert.equal(bad.status, 401)
  const noWorkspace = await mcp(c, credentials.machine, 'list_documents', { repository: 'local/forbidden' })
  assert.equal(noWorkspace.isError, true)
  const human = await fetch(c + '/auth/offline', { method: 'POST', redirect: 'manual', headers: { origin: c }, body: new URLSearchParams({ id: 'operator', secret: credentials.human }) })
  assert.equal(human.status, 303)
  const chopinCookie = human.headers.get('set-cookie').split(';')[0]
  const login = await fetch(w + '/api/operator/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ passcode: credentials.operator }) })
  assert.equal(login.status, 200)
  const cookie = login.headers.get('set-cookie').split(';')[0]
  const op = async (route, body) => json(w + route, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const state = () => json(w + '/api/state', { headers: { cookie } })
  const created = await mcp(c, credentials.machine, 'create_document', { idempotencyKey: 'local-proof', repository: 'local/proof', baseBranch: 'dev', baseCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: chopin, encoding: 'utf8' }).trim(), title: 'Local restart proof', plan: '# Local restart proof\n\nSynthetic local review.\n', brief: { goal: 'Prove local restart', constraints: [], settledDecisions: [], openQuestions: [], repositoryFindings: [] } })
  assert.ok(!created.isError, JSON.stringify(created))
  const documentId = created.structuredContent.id
  const id = () => '01' + randomBytes(12).toString('hex').toUpperCase()
  const request = { documentId, requestId: id(), question: 'May the synthetic worker continue?', options: [{ id: id(), label: 'Approve' }, { id: id(), label: 'Reject' }] }
  const card = await json(c + '/api/offline/decisions', { method: 'POST', headers: { authorization: `Bearer ${credentials.machine}`, origin: c }, body: JSON.stringify(request) })
  const retry = await json(c + '/api/offline/decisions', { method: 'POST', headers: { authorization: `Bearer ${credentials.machine}`, origin: c }, body: JSON.stringify(request) })
  assert.equal(retry.id, card.id)
  const stale = await mcp(c, credentials.machine, 'answer_decision', { id: documentId, questionId: card.id, revision: card.revision + 1, optionIds: [request.options[0].id], idempotencyKey: 'stale-proof' })
  assert.equal(stale.structuredContent.code, 'stale')
  const envelope = { schema: 'who-decides.decision-request.v0', sourceSystem: 'chopin', question: request.question, options: request.options, coordination: { documentId, questionId: card.id, revision: card.revision }, contextRefs: [`chopin:document:${documentId}`], digests: [{ algorithm: 'sha256', value: hash(JSON.stringify(request)) }] }
  const workerFile = path.join(dir, 'worker.json')
  write(workerFile, { wd: w, chopin: c, machine: credentials.machine, intake: credentials.intake, envelope })
  const runWorker = async () => { const worker = launch(process.execPath, [path.resolve('scripts/private-local-proof.mjs'), '--worker', workerFile], wdRoot, {}, 'worker'); assert.equal((await worker.done).code, 0) }
  await runWorker()
  const runId = read(workerFile).runId
  assert.deepEqual(await json(w + `/api/artifacts/decision-request?run=${runId}`, { headers: { cookie } }), envelope)
  assert.equal((await state()).state, 'decision_required')
  // Restart both apps while the decision is pending. Browser sessions must survive.
  await Promise.all([stop(cs), stop(ws)])
  cs = startChopin(); ws = startWd(); await Promise.all([ready(c, '/api/session', cs), ready(w, '/api/state', ws)])
  assert.equal((await json(c + '/api/session', { headers: { cookie: chopinCookie } })).user.id, 'local:human:operator')
  assert.equal((await state()).runId, runId)
  assert.equal((await state()).state, 'decision_required')
  // Synthetic operator submission exercises the real login route; it is not human acceptance.
  await op('/api/decision', { runId, choice: request.options[0].id, rationale: 'Synthetic restart fixture selection', idempotencyKey: 'synthetic-choice' })
  assert.equal(dropped, 1)
  assert.equal((await state()).outbox[0].status, 'unknown')
  let before = (await mcp(c, credentials.machine, 'read_coordination_snapshot', { id: documentId })).structuredContent
  assert.equal(before.decisions[0].status, 'answered')
  console.log('proof: settlement committed; killing both apps before retry')
  cs.kill('SIGKILL'); ws.kill('SIGKILL'); await Promise.all([cs.done, ws.done])
  // The dead writer keeps its persisted lease until expiry; never force-clear it.
  await new Promise(resolve => setTimeout(resolve, 31_000))
  cs = startChopin(); ws = startWd(); await Promise.all([ready(c, '/api/session', cs), ready(w, '/api/state', ws)])
  await op('/api/bridge/resume', { runId })
  assert.equal((await state()).outbox[0].status, 'confirmed')
  assert.equal(answerCalls, 2)
  const after = (await mcp(c, credentials.machine, 'read_coordination_snapshot', { id: documentId })).structuredContent
  assert.deepEqual(after, before)
  await op('/api/bridge/resume', { runId, probe: true })
  assert.equal(answerCalls, 2)
  await runWorker()
  await json(w + '/api/state', { method: 'DELETE', headers: { cookie } })
  const rejectRequest = { ...request, requestId: id() }
  const rejectCard = await json(c + '/api/offline/decisions', { method: 'POST', headers: { authorization: `Bearer ${credentials.machine}`, origin: c }, body: JSON.stringify(rejectRequest) })
  const rejectEnvelope = { ...envelope, coordination: { ...envelope.coordination, questionId: rejectCard.id, revision: rejectCard.revision } }
  const rejectedRun = await json(w + '/api/external/decisions', { method: 'POST', headers: { authorization: `Bearer ${credentials.intake}`, 'content-type': 'application/json' }, body: JSON.stringify(rejectEnvelope) })
  await op('/api/decision', { runId: rejectedRun.runId, choice: request.options[1].id, rationale: 'Synthetic rejection; do not continue', idempotencyKey: 'synthetic-reject' })
  assert.equal((await state()).outbox[0].status, 'confirmed')
  assert.deepEqual((await state()).outbox[0].result.result.settled.choices, [request.options[1].id])
  assert.equal(answerCalls, 3)
  before = (await mcp(c, credentials.machine, 'read_coordination_snapshot', { id: documentId })).structuredContent
  await Promise.all([stop(cs), stop(ws)])
  const backup = path.join(dir, 'restored'); mkdirSync(backup)
  cpSync(path.join(dir, 'wd'), path.join(backup, 'wd'), { recursive: true })
  cpSync(path.join(dir, 'chopin.sqlite'), path.join(backup, 'chopin.sqlite'))
  activeDir = backup
  cs = startChopin(); ws = startWd(); await Promise.all([ready(c, '/api/session', cs), ready(w, '/api/state', ws)])
  assert.equal((await state()).outbox[0].status, 'confirmed')
  assert.deepEqual((await mcp(c, credentials.machine, 'read_coordination_snapshot', { id: documentId })).structuredContent, before)
  write(path.join(dir, 'result.json'), { passed: true, observedAt: new Date().toISOString(), fixture: 'synthetic-operator-not-human-acceptance', osEgressDenied: egress,
    pendingRestart: true, abruptCrashRecovery: true, encryptedSessionRestart: true, lostResponseRecovery: true, exactAnswerWireAttempts: answerCalls, independentSettlements: 2, approvalAndRejection: true, duplicateNoRedispatch: true, workerRestart: true, stoppedBackupRestore: true,
    staleAnswerRefused: true, privateReads: true, invalidMachineRefused: true, unauthorizedWorkspaceRefused: true, migrationAttempted: false,
    commits: { chopin: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: chopin, encoding: 'utf8' }).trim(), whoDecides: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: wdRoot, encoding: 'utf8' }).trim() },
    sourceDiffSha256: { chopin: hash(execFileSync('git', ['diff', 'HEAD', '--'], { cwd: chopin })), whoDecides: hash(execFileSync('git', ['diff', 'HEAD', '--'], { cwd: wdRoot })) },
    generatorSha256: hash(readFileSync(import.meta.filename)), inputSha256: hash(JSON.stringify([request, rejectRequest])) })
  console.log(JSON.stringify({ passed: true, result: path.join(dir, 'result.json'), humanAcceptance: 'pending' }))
} finally {
  await Promise.all([...children].map(stop))
  proxy.closeAllConnections(); proxy.close()
}
