/** Foreground supervisor for the model-free local PoC; no GitHub or provider credentials. */
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const chopin = path.resolve(process.argv[2] ?? '')
if (!process.argv[2] || !process.env.LOCAL_PROOF_BUN) throw Error('Usage: LOCAL_PROOF_BUN=/path/to/bun node scripts/private-local-start.mjs /path/to/chopin [data-directory]')
const dir = path.resolve(process.argv[3] ?? '.tmp/private-local')
mkdirSync(dir, { recursive: true, mode: 0o700 })
const write = (name, value) => writeFileSync(path.join(dir, name), value, { mode: 0o600 })
const secretPath = path.join(dir, 'secrets.json')
const secrets = existsSync(secretPath) ? JSON.parse(readFileSync(secretPath, 'utf8')) : Object.fromEntries(['key', 'human', 'machine', 'intake', 'operator'].map(k => [k, randomBytes(32).toString('hex')]))
if (!existsSync(secretPath)) write('secrets.json', JSON.stringify(secrets, null, 2) + '\n')
const hash = s => createHash('sha256').update(s).digest('hex')
if (!existsSync(path.join(dir, 'directory.json'))) write('directory.json', JSON.stringify({ workspaces: [{ name: 'local/proof', path: chopin, branch: 'dev' }], principals: [
  { id: 'operator', kind: 'human', secretHash: hash(secrets.human), workspaces: { 'local/proof': 'write' } },
  { id: 'bridge', kind: 'machine', secretHash: hash(secrets.machine), workspaces: { 'local/proof': 'write' } },
] }, null, 2) + '\n')
write('chopin-passcode.txt', secrets.human + '\n')
write('operator-passcode.txt', secrets.operator + '\n')
write('bridge-token.txt', secrets.machine + '\n')
const c = 'http://127.0.0.1:18798', w = 'http://127.0.0.1:13100'
const common = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR ?? '/tmp', NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1' }
const policy = '(version 1)(allow default)(deny network*)(allow network-inbound (local ip "localhost:*"))(allow network-outbound (remote ip "localhost:*"))(allow network-bind (local ip "localhost:*"))'
if (process.platform !== 'darwin') throw Error('This supervisor currently uses the tested macOS sandbox. Port the OS egress control before running on another platform.')
const children = []
function start(command, cwd, env) {
  const child = spawn('/usr/bin/sandbox-exec', ['-p', policy, ...command], { cwd, env: { ...common, ...env }, stdio: 'inherit' })
  children.push(child)
  child.once('error', () => { process.exitCode = 1; stop() })
  child.once('exit', code => { if (code) process.exitCode = code; stop() })
}
let stopping = false
function stop() {
  if (stopping) return
  stopping = true
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  const timer = setTimeout(() => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }, 8000)
  timer.unref()
}
process.on('SIGINT', stop); process.on('SIGTERM', stop)
start([process.env.LOCAL_PROOF_BUN, 'apps/server/src/main.ts'], chopin, {
  AUTH_MODE: 'offline', AGENT: 'off', BACKGROUND_JOBS: 'off', STORAGE_DRIVER: 'sqlite', SQLITE_PATH: path.join(dir, 'chopin.sqlite'),
  SESSION_ENCRYPTION_KEY: secrets.key, CHOPIN_OFFLINE_DIRECTORY: path.join(dir, 'directory.json'), SERVER_HOST: '127.0.0.1', PORT: '18798', APP_ORIGIN: c,
  EXTERNAL_COORDINATION: 'on', COORDINATION_APPROVERS: 'bridge',
})
start([process.execPath, 'node_modules/next/dist/bin/next', 'start', '-H', '127.0.0.1', '-p', '13100'], process.cwd(), {
  WD_PROFILE: 'private-local', WD_STORE: 'sqlite', WD_CONSOLE_DIR: path.join(dir, 'wd'), WD_OPERATOR_PASSCODE_HASH: hash(secrets.operator),
  WD_BRIDGE_TOKEN_HASH: hash(secrets.intake), WD_CHOPIN_URL: c, WD_CHOPIN_ORIGIN: c, WD_CHOPIN_TOKEN_FILE: path.join(dir, 'bridge-token.txt'),
})
console.log(`Chopin: ${c} (local user: operator)\nWho-Decides: ${w}\nPrivate passcode files: ${dir}\nStop with Ctrl-C. Re-run this command with the same directory to resume.`)
