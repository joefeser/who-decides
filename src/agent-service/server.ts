/* AgentCore Runtime service shape: a long-running HTTP server on port 8080
 * implementing the runtime contract — GET /ping (health) and POST
 * /invocations (payload delivery). Each invocation is stateless against
 * the process: run state lives on the durable data directory, the agent
 * resumes from persisted snapshots. This is the terminal-stop +
 * seeded-resume ruling (M1) as a service.
 *
 * Start: WD_AGENT_DATA_DIR=/mnt/data/agent WD_AGENT_PORT=8080 npm run agent:start
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { Scenario } from '../artifacts/build'
import { startPhase, resumePhase } from '../agent-core/phases'
import { createMachineAuth, attestMachinePrincipal } from './machine-auth'
import type { ServiceContext } from '../agent-core/phases'

const PORT = Number(process.env.WD_AGENT_PORT ?? 8080)
const DATA_DIR = process.env.WD_AGENT_DATA_DIR ?? path.resolve(process.cwd(), '.tmp/agent-service')
// The claim DB defaults INSIDE the data directory so a single WD_AGENT_DATA_DIR
// configuration keeps claims with the run state they protect (review finding).
const CLAIM_DB = process.env.WD_AGENT_CLAIM_DB ?? path.join(DATA_DIR, 'consumption.db')

function loadFixture(): Scenario {
  return JSON.parse(
    readFileSync(path.resolve(process.cwd(), 'fixtures/patch-scenario.json'), 'utf8'),
  ) as Scenario
}

const ctx: ServiceContext = { dataDir: DATA_DIR, claimDb: CLAIM_DB, fixture: loadFixture() }
const machineAuth = createMachineAuth({ tokenHash: process.env.WD_MACHINE_TOKEN_HASH })

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let overflowed = false
    req.on('data', (chunk: Buffer) => {
      if (overflowed) return // stop accumulating; drain without destroying so the 400 can be sent
      size += chunk.length
      if (size > 1024 * 1024) { overflowed = true; reject(new Error('PAYLOAD_TOO_LARGE')); return }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
      catch { reject(new Error('INVALID_JSON')) }
    })
    req.on('error', reject)
  })
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const bytes = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(bytes) })
  res.end(bytes)
}

const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/ping') {
    return send(res, 200, { ok: true, service: 'who-decides-agent', dataDir: DATA_DIR })
  }
  if (req.method === 'POST' && req.url === '/invocations') {
    // Machine-principal gate: the agent runtime authenticates with a scoped
    // service token (AC-2). Operators never call this endpoint; the console
    // dispatches on their behalf after its own auth. Fail closed on absent
    // or invalid credentials — /ping stays open for health checks.
    const auth = machineAuth.authorize(req as unknown as Request)
    if (!auth.ok) {
      const status = auth.error === 'MACHINE_AUTH_REQUIRED' || auth.error === 'MACHINE_AUTH_INVALID' ? 401 : 503
      return send(res, status, { ok: false, error: auth.error })
    }
    let payload: Record<string, unknown>
    try { payload = await readJson(req) }
    catch (err) { return send(res, 400, { ok: false, error: String((err as Error).message ?? err) }) }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      return send(res, 400, { ok: false, error: 'INVALID_BODY: expected a JSON object' })
    }

    const kind = payload.kind
    const tag = typeof payload.sessionId === 'string' ? payload.sessionId : ''
    // Malformed session ids are client errors, not service failures
    // (review P2): validate shape before the phases and return 400s.
    if (!tag || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(tag)) {
      return send(res, 400, { ok: false, error: `INVALID_SESSION_ID: must be a filename-safe slug (letters, digits, . _ -; max 64 chars), got "${String(payload.sessionId).slice(0, 24)}"` })
    }
    try {
      if (kind === 'decision-run') {
        const result = await startPhase(ctx, { tag })
        return send(res, result.status === 'ENVIRONMENT_BLOCKED' || result.status === 'HUMAN_DECISION_REQUIRED' ? 409 : 200, { ok: true, result })
      }
      if (kind === 'decision-resume') {
        const choice = typeof payload.choice === 'string' ? payload.choice : ''
        const rationale = typeof payload.rationale === 'string' ? payload.rationale : ''
        const result = await resumePhase(ctx, { tag, choice, rationale, machinePrincipal: attestMachinePrincipal(auth) })
        const conflict = result.status === 'INVALID_INPUT' || result.status === 'STATE_CONFLICT' || result.status === 'CLAIM_REJECTED'
        return send(res, conflict ? 409 : 200, { ok: !conflict, result })
      }
      return send(res, 400, { ok: false, error: `UNKNOWN_KIND:${String(kind)}` })
    } catch (err) {
      return send(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return send(res, 404, { ok: false, error: 'NOT_FOUND' })
})

// The listener starts ONLY when run directly as the service entry point —
// never when the module is imported (tests, future host embedding). This
// also prevents tsx --test workers from opening port 8080.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  server.listen(PORT, () => {
    console.log(`[agent-service] listening on :${PORT} data=${DATA_DIR} claim=${CLAIM_DB}`)
  })
}

export { server, ctx, readJson, send }
