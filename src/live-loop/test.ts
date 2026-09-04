import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fork, spawnSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '../..')
const childScript = path.join(root, 'scripts/live-loop-test-child.ts')
const loader = path.join(root, 'node_modules/tsx/dist/loader.mjs')
function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'wd-live-test-'))
  cpSync(path.join(root, 'schemas'), path.join(dir, 'schemas'), { recursive: true })
  mkdirSync(path.join(dir, 'fixtures'))
  copyFileSync(path.join(root, 'fixtures/patch-scenario.json'), path.join(dir, 'fixtures/patch-scenario.json'))
  return dir
}
function env(extra = {}) { return { NODE_ENV: 'test' as const, PATH: process.env.PATH, WD_LIVE_TAG: 'test', ...extra } }
function run(dir: string, extra = {}) {
  return spawnSync(process.execPath, ['--import', loader, childScript], { cwd: dir, env: env(extra), encoding: 'utf8', timeout: 10000 })
}
const statePath = (dir: string) => path.join(dir, '.tmp/live-loop/state-test.json')
const events = (dir: string) => existsSync(path.join(dir, 'events.log')) ? readFileSync(path.join(dir, 'events.log'), 'utf8') : ''

test('empty and whitespace rationale stop before runtime construction or run writes', () => {
  const dir = fixture()
  try {
    for (const value of ['', '   ']) {
      const result = run(dir, { WD_LIVE_RATIONALE: value })
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /RATIONALE_REQUIRED/)
      assert.equal(events(dir), '')
      assert.equal(existsSync(path.join(dir, '.tmp')), false)
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('completed run is read-only on restart; each non-approval choice retains its rationale', () => {
  for (const choice of ['create_draft_pr', 'send_back', 'defer']) {
    const dir = fixture()
    try {
      const first = run(dir, { WD_LIVE_CHOICE: choice })
      assert.equal(first.status, 0, first.stderr)
      const bytes = readFileSync(statePath(dir), 'utf8')
      const state = JSON.parse(bytes)
      assert.equal(state.phase, 'completed')
      assert.equal(state.choice, choice)
      assert(state.rationale.length > 0)
      if (choice !== 'create_draft_pr') assert.doesNotMatch(state.rationale, /outweighs/)
      const second = run(dir, { WD_LIVE_CHOICE: choice })
      assert.equal(second.status, 0, second.stderr)
      assert.match(second.stdout, /RUN_ALREADY_COMPLETED/)
      assert.equal(events(dir), 'runtime\nA\nB\n')
      assert.equal(readFileSync(statePath(dir), 'utf8'), bytes)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }
})

test('crash after B starts cannot take over dead holder or overwrite prior state', () => {
  const dir = fixture()
  try {
    assert.equal(run(dir, { WD_TEST_CRASH: '1' }).status, 17)
    const bytes = readFileSync(statePath(dir), 'utf8')
    assert.equal(JSON.parse(bytes).phase, 'claimed')
    const second = run(dir)
    assert.equal(second.status, 0, second.stderr)
    assert.match(second.stdout, /HUMAN_DECISION_REQUIRED/)
    assert.equal(events(dir), 'runtime\nA\nB\n')
    assert.equal(readFileSync(statePath(dir), 'utf8'), bytes)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('incomplete historical state without snapshot fails closed before any invocation', () => {
  const dir = fixture()
  try {
    mkdirSync(path.dirname(statePath(dir)), { recursive: true })
    const bytes = JSON.stringify({ phase: 'claimed', choice: 'defer', rationale: 'wait', invocationB: 'original' })
    writeFileSync(statePath(dir), bytes)
    const result = run(dir, { WD_LIVE_CHOICE: 'defer', WD_LIVE_RATIONALE: 'wait' })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /HUMAN_DECISION_REQUIRED/)
    assert.equal(events(dir), '')
    assert.equal(readFileSync(statePath(dir), 'utf8'), bytes)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('existing empty/dead reservation is never overwritten or taken over', () => {
  const dir = fixture()
  try {
    mkdirSync(path.dirname(statePath(dir)), { recursive: true })
    const lease = path.join(dir, '.tmp/live-loop/lease-test.json')
    for (const bytes of ['', JSON.stringify({ holderPid: 99999999 })]) {
      writeFileSync(lease, bytes)
      const result = run(dir)
      assert.equal(result.status, 0, result.stderr)
      assert.match(result.stdout, /HUMAN_DECISION_REQUIRED/)
      assert.equal(events(dir), '')
      assert.equal(readFileSync(lease, 'utf8'), bytes)
      assert.equal(existsSync(statePath(dir)), false)
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('overlapping first-time processes cannot replace the winner state or invoke twice', async () => {
  const dir = fixture()
  const children = [0, 1].map(() => {
    const proc = fork(childScript, [], { cwd: dir, env: env(), execArgv: ['--import', loader], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    let output = ''
    proc.stdout!.on('data', data => { output += data })
    proc.stderr!.on('data', data => { output += data })
    const ready = new Promise<void>((resolve, reject) => { proc.once('message', () => resolve()); proc.once('exit', code => reject(new Error(`child exited before ready: ${code}: ${output}`))) })
    const exit = new Promise<number | null>(resolve => proc.once('exit', resolve))
    return { proc, ready, exit, output: () => output }
  })
  const timeout = setTimeout(() => children.forEach(c => c.proc.kill()), 10000)
  try {
    await Promise.all(children.map(c => c.ready))
    children.forEach(c => c.proc.send('go'))
    const codes = await Promise.all(children.map(c => c.exit))
    assert.deepEqual(codes, [0, 0], children.map(c => c.output()).join('\n'))
    assert.equal(events(dir), 'runtime\nA\nB\n')
    assert.equal(JSON.parse(readFileSync(statePath(dir), 'utf8')).phase, 'completed')
    assert.equal(children.filter(c => c.output().includes('HUMAN_DECISION_REQUIRED')).length, 1)
  } finally { clearTimeout(timeout); children.forEach(c => { if (c.proc.exitCode === null) c.proc.kill() }); rmSync(dir, { recursive: true, force: true }) }
})
