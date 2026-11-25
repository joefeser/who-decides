/** Prepare/read a synthetic human walkthrough. Never submits an operator decision. */
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

const mode = process.argv[2]
assert.ok(['prepare', 'status'].includes(mode), 'Usage: node scripts/private-local-walkthrough.mjs prepare|status [data-directory]')
const dir = path.resolve(process.argv[3] ?? '.tmp/private-local')
const read = name => JSON.parse(readFileSync(path.join(dir, name), 'utf8'))
const save = value => writeFileSync(path.join(dir, 'walkthrough.json'), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
const credentials = read('secrets.json')
const c = 'http://127.0.0.1:18798', w = 'http://127.0.0.1:13100'
async function json(url, init) {
  const response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(15000) })
  assert.ok(response.ok, `HTTP ${response.status}; inspect the local app, do not blindly repeat intake`)
  return response.json()
}
async function mcp(name, args) {
  const body = await json(c + '/mcp', { method: 'POST', headers: { authorization: `Bearer ${credentials.machine}`, origin: c, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })
  assert.ok(!body.error && !body.result?.isError, 'Chopin refused the request')
  return body.result.structuredContent
}
let record = existsSync(path.join(dir, 'walkthrough.json')) ? read('walkthrough.json') : undefined
if (mode === 'prepare') {
  if (!record) {
    const workspace = read('directory.json').workspaces.find(x => x.name === 'local/proof')
    assert.ok(workspace, 'Register the local/proof workspace first')
    const id = () => '01' + randomBytes(12).toString('hex').toUpperCase()
    record = { baseCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace.path, encoding: 'utf8' }).trim(), requestId: id(), options: [{ id: id(), label: 'Approve synthetic continuation' }, { id: id(), label: 'Reject synthetic continuation' }], humanAcceptance: 'pending' }
    save(record)
  }
  if (!record.documentId) {
    const created = await mcp('create_document', { idempotencyKey: 'human-walkthrough-' + record.requestId, repository: 'local/proof', baseBranch: 'dev', baseCommit: record.baseCommit, title: 'Human local restart walkthrough', plan: '# Local restart walkthrough\n\nSynthetic evidence only. No migration or real execution.\n', brief: { goal: 'Verify human choice survives restart', constraints: ['No migration'], settledDecisions: [], openQuestions: [], repositoryFindings: [] } })
    record.documentId = created.id; save(record)
  }
  if (!record.envelope) {
    const request = { documentId: record.documentId, requestId: record.requestId, question: 'May the synthetic worker continue after this local restart check?', options: record.options }
    const card = await json(c + '/api/offline/decisions', { method: 'POST', headers: { authorization: `Bearer ${credentials.machine}`, origin: c }, body: JSON.stringify(request) })
    record.envelope = { schema: 'who-decides.decision-request.v0', sourceSystem: 'chopin', question: request.question, options: request.options, coordination: { documentId: record.documentId, questionId: card.id, revision: card.revision }, contextRefs: [`chopin:document:${record.documentId}`], digests: [{ algorithm: 'sha256', value: createHash('sha256').update(JSON.stringify(request)).digest('hex') }] }
    save(record)
  }
  if (!record.runId) {
    assert.ok(!record.intakeAttempted, 'Intake outcome unknown. Inspect Who-Decides for the matching question before any retry; do not delete the marker.')
    record.intakeAttempted = true; save(record)
    const run = await json(w + '/api/external/decisions', { method: 'POST', headers: { authorization: `Bearer ${credentials.intake}`, 'content-type': 'application/json' }, body: JSON.stringify(record.envelope) })
    record.runId = run.runId; save(record)
  }
}
assert.ok(record?.envelope, 'Prepare the walkthrough first')
const snapshot = await mcp('read_coordination_snapshot', { id: record.documentId })
const decision = snapshot.decisions.find(x => x.id === record.envelope.coordination.questionId)
assert.ok(decision, 'Expected card missing; inspect before continuing')
console.log(JSON.stringify({ runId: record.runId, documentId: record.documentId, decision, humanAcceptance: 'pending: record your own walkthrough result separately', execution: 'none; synthetic fixture only' }, null, 2))
