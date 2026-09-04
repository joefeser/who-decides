// Model-free local contention proof. Test-only SQL observations identify both
// replay paths; no production test hooks or provider/effect calls are used.
import assert from 'node:assert/strict'
import { fork, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { ConsumptionStore, decisionDigest } from '../src/consumption/store.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const self = fileURLToPath(import.meta.url)
const iso = () => new Date().toISOString()
const sample = (id, action = 'dry-run only') => ({ decisionId: id, chosenOption: 'dry_run', rationale: 'proof fixture', decidedAt: '2026-09-04T00:00:00Z', decisionRequestId: 'request-proof', permittedAction: action })
const sha = bytes => createHash('sha256').update(bytes).digest('hex')

if (process.env.WD_PROOF_CHILD === '1') {
  const originalPrepare = Database.prototype.prepare
  Database.prototype.prepare = function (sql) {
    const statement = originalPrepare.call(this, sql)
    if (sql.startsWith('SELECT receipt_json, successor_invocation_id, decision_digest')) {
      const get = statement.get.bind(statement)
      statement.get = (...args) => {
        const row = get(...args)
        process.send({ kind: row ? 'read-existing' : 'read-empty', at: iso(), pid: process.pid })
        return row
      }
    }
    if (sql.startsWith('INSERT INTO consumption_receipts')) {
      const run = statement.run.bind(statement)
      statement.run = (...args) => {
        try { return run(...args) } catch (error) {
          if (error.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') process.send({ kind: 'unique-conflict', at: iso(), pid: process.pid })
          throw error
        }
      }
    }
    return statement
  }
  const store = new ConsumptionStore(process.env.WD_PROOF_DB)
  process.send({ kind: 'ready', pid: process.pid })
  process.once('message', () => {
    const beganAt = iso()
    try {
      const decision = JSON.parse(process.env.WD_PROOF_DECISION)
      const result = store.claim(decision, process.env.WD_PROOF_SUCCESSOR, decisionDigest(decision))
      process.send({ kind: 'result', beganAt, endedAt: iso(), pid: process.pid, result })
    } finally { store.close(); process.disconnect() }
  })
} else {
  const output = process.argv[2]
  assert(output, 'usage: node --import tsx scripts/consumption-proof.mjs <NEW_OUTPUT_DIRECTORY>')
  mkdirSync(output, { recursive: false }) // Never overwrite prior proof/history.
  function child(db, decision, successor) {
    const proc = fork(self, [], { execArgv: ['--import', 'tsx'], env: {
      PATH: process.env.PATH, WD_PROOF_CHILD: '1', WD_PROOF_DB: db,
      WD_PROOF_DECISION: JSON.stringify(decision), WD_PROOF_SUCCESSOR: successor,
    }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
    const messages = []
    const listeners = new Set()
    proc.on('message', m => { messages.push(m); for (const listener of listeners) listener() })
    const exit = new Promise((resolve, reject) => {
      proc.on('error', reject)
      proc.on('exit', code => code === 0 ? resolve() : reject(new Error(`child exit ${code}`)))
    })
    exit.catch(() => {})
    const wait = kind => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { listeners.delete(check); proc.kill(); reject(new Error(`timeout: ${kind}`)) }, 10000)
      const check = () => {
        const found = messages.find(m => m.kind === kind)
        if (found) { clearTimeout(timer); listeners.delete(check); resolve(found) }
      }
      listeners.add(check); check()
    })
    return { proc, messages, wait, exit }
  }
  const trials = []
  for (const mode of ['competing', 'competing', 'competing', 'changed-action', 'identical']) {
    const id = `trial-${trials.length}`
    const dbPath = path.resolve(output, `${id}.db`)
    new ConsumptionStore(dbPath).close()
    const lock = new Database(dbPath)
    const inputs = [sample(id), sample(id, mode === 'changed-action' ? 'changed action' : 'dry-run only')]
    const successors = ['successor-a', mode === 'competing' ? 'successor-b' : 'successor-a']
    const children = inputs.map((input, i) => child(dbPath, input, successors[i]))
    try {
      await Promise.all(children.map(c => c.wait('ready')))
      lock.exec('BEGIN IMMEDIATE')
      const lockedAt = iso()
      children.forEach(c => c.proc.send('go'))
      // Both SELECTs must finish with no winner while our write lock is held.
      await Promise.all(children.map(c => c.wait('read-empty')))
      await new Promise(resolve => setTimeout(resolve, 100))
      const releasedAt = iso()
      lock.exec('COMMIT')
      const results = await Promise.all(children.map(c => c.wait('result')))
      await Promise.all(children.map(c => c.exit))
      assert(results.every(r => r.beganAt <= releasedAt && r.endedAt >= releasedAt))
      assert.equal(results.filter(r => r.result.status === 'claimed').length, 1)
      const winner = results.findIndex(r => r.result.status === 'claimed')
      const loser = 1 - winner
      assert(children[loser].messages.some(m => m.kind === 'unique-conflict'))
      if (mode === 'identical') assert.equal(results[loser].result.status, 'replayed')
      else {
        assert.equal(results[loser].result.status, 'rejected')
        assert.equal(results[loser].result.reason, mode === 'competing' ? 'competing_successor' : 'digest_mismatch')
      }
      const rows = lock.prepare('SELECT receipt_json FROM consumption_receipts').all()
      assert.equal(rows.length, 1)
      const persisted = JSON.parse(rows[0].receipt_json)
      assert.deepEqual(persisted, results[winner].result.receipt)
      // All claim processes exited. A fresh process must return the exact winner.
      const recovery = child(dbPath, inputs[winner], successors[winner])
      await recovery.wait('ready'); recovery.proc.send('go')
      const restart = await recovery.wait('result'); await recovery.exit
      assert.equal(restart.result.status, 'replayed')
      assert.deepEqual(restart.result.receipt, persisted)
      assert(recovery.messages.some(m => m.kind === 'read-existing'))
      const reopened = new ConsumptionStore(dbPath)
      if (mode === 'changed-action') {
        const ordinaryReplay = reopened.claim(inputs[loser], successors[loser], decisionDigest(inputs[loser]))
        assert.equal(ordinaryReplay.status, 'rejected')
        assert.equal(ordinaryReplay.reason, 'digest_mismatch')
      }
      assert.deepEqual(reopened.getReceipt(id), persisted)
      reopened.close()
      trials.push({ mode, lockedAt, releasedAt, inputs, successors, processes: children.map(c => c.messages), persisted, restart })
    } finally {
      if (lock.inTransaction) lock.exec('ROLLBACK')
      lock.close()
      children.forEach(c => { if (c.proc.exitCode === null) c.proc.kill() })
    }
  }
  const files = ['src/consumption/store.ts', 'src/consumption/test.ts', 'scripts/consumption-proof.mjs', 'package-lock.json']
  const manifest = {
    schema: 'who-decides.local-consumption-proof.v1', observedAt: iso(),
    gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    trackedDiffSha256: sha(execFileSync('git', ['diff', 'HEAD', '--'], { cwd: root })),
    sourceHashes: Object.fromEntries(files.map(file => [file, sha(readFileSync(path.join(root, file)))])),
    node: process.version, platform: process.platform, arch: process.arch,
    trials, modelCalls: 0, externalEffects: 0,
    limitations: ['local SQLite contention, not distributed proof', 'receipt replay is not permission to restart an effect',
      'no guarded start, revocation, authenticated issuer, or ambiguity proof', 'not owner acceptance or HACP conformance'],
  }
  writeFileSync(path.join(output, 'result.json'), JSON.stringify(manifest, null, 2) + '\n')
  console.log(JSON.stringify({ passed: true, trials: trials.length, result: path.resolve(output, 'result.json') }))
}
