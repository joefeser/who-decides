/* Chopin outbox transport (full-dress): the A2 dispatcher interface over
 * chopin's MCP surface.
 *
 * EXACT-PAYLOAD RULE (outbox.ts): the op's persisted payload is sent verbatim
 * — `payload.tool` names the MCP tool, `payload.arguments` is forwarded
 * untouched. Nothing is re-derived from a fresh read; if the target moved,
 * the receiver's typed refusal is the honest outcome.
 *
 * CONFIRMATION CONTRACT (review round 1, P1-3): a settle is confirmed only
 * on a 2xx response whose JSON-RPC result matches the call id, carries no
 * error indication, and includes chopin's settled fields (choices, by, at)
 * with choices matching the persisted answer. `state` strings alone never
 * confirm — both genuine settles and B4 replays carry the full settle.
 *
 * OUTCOME MAPPING (unknown stays unknown; review round 1, P1-2):
 *  - recoverable conditions (paused, implementation-active,
 *    draft-in-progress, state-diverged) → unknown: chopin checks
 *    implementation-active and paused BEFORE B4 replay, so a lost response
 *    followed by such a refusal must stay resumable, never failed
 *  - unrepairable, explicit terminal evidence (idempotency-conflict,
 *    unknown-decision, not-allowed, resolved-with-message, archived) → failed
 *  - uninterpreted receiver responses (unrecognized codes, unparseable
 *    text, RPC errors, 5xx, malformed bodies) → unknown, never fabricated
 *  - transport loss → unknown with a FIXED diagnostic (never the exception
 *    text: a malformed bearer once leaked through Headers' error message
 *    into the persisted result, review round 1, P1-1)
 */
import { readFileSync } from 'node:fs'
import type { OutboxDispatcher, OutboxDispatchOutcome } from './outbox'

export type ChopinTransportConfig = {
  /** Chopin's base URL, e.g. http://localhost:8788. */
  baseUrl: string
  /** Bearer credential — the bridge caller's fine-grained token. */
  token: string
  /** Origin header chopin requires; defaults to `baseUrl`. */
  origin?: string
  /** Call timeout in ms. A hung receiver resolves the op unknown. */
  timeoutMs?: number
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch
}

const DEFAULT_TIMEOUT_MS = 10_000
const CALL_ID = 2

/** A transport configuration a caller can fix; never carries token material. */
export class BridgeTransportConfigError extends Error {}

/** Whether the value can serve as a Bearer credential: non-empty, free of
 * control characters, and accepted by Node's Headers. The explicit control-
 * character check comes first — Headers alone tolerates some line breaks
 * (sol round-1 probe: a multiline token constructed fine and its exception
 * text later carried the value). */
export function isValidBearerToken(value: string): boolean {
  if (value.length === 0 || value.trim() !== value) return false
  if (/[\x00-\x1F\x7F]/.test(value)) return false
  try {
    new Headers({ authorization: `Bearer ${value}` })
    return true
  } catch {
    return false
  }
}

type McpCallResult = {
  result?: {
    isError?: boolean
    structuredContent?: { state?: string, code?: string, message?: string, settled?: unknown, [key: string]: unknown }
    content?: Array<{ type: string, text?: string }>
  }
  error?: { code: number, message: string }
}

/** One MCP round trip: initialize → initialized → tools/call, SSE framing
 * stripped. Session binding follows chopin's initialize response header. */
async function chopinToolCall(
  config: ChopinTransportConfig,
  tool: string,
  args: unknown,
): Promise<{ http: number, body: (McpCallResult & { id?: unknown }) | undefined }> {
  const fetchImpl = config.fetchImpl ?? fetch
  const base = config.baseUrl.replace(/\/$/, '')
  const origin = config.origin ?? config.baseUrl
  const headers = {
    'authorization': `Bearer ${config.token}`,
    'content-type': 'application/json',
    'accept': 'application/json, text/event-stream',
    'origin': origin,
  }
  const init = await fetchImpl(`${base}/mcp`, {
    method: 'POST',
    headers: new Headers(headers),
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'who-decides-bridge', version: '1.0' } },
    }),
    signal: AbortSignal.timeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  })
  if (!init.ok) return { http: init.status, body: undefined }
  const session = init.headers.get('mcp-session-id')
  if (session) {
    await fetchImpl(`${base}/mcp`, {
      method: 'POST',
      headers: { ...headers, 'mcp-session-id': session },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      signal: AbortSignal.timeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    }).catch(() => {})
  }
  const call = await fetchImpl(`${base}/mcp`, {
    method: 'POST',
    headers: session ? { ...headers, 'mcp-session-id': session } : headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: CALL_ID, method: 'tools/call', params: { name: tool, arguments: args } }),
    signal: AbortSignal.timeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  })
  const text = await call.text()
  const dataLine = text.split('\n').filter(line => line.startsWith('data:')).at(-1)
  const body = dataLine
    ? JSON.parse(dataLine.slice(5).trim()) as McpCallResult
    : text.trim().startsWith('{')
    ? JSON.parse(text) as McpCallResult
    : undefined
  return { http: call.status, body }
}

/** Whether the response carries a genuine settle: JSON-RPC success for the
 * tools/call id, no error indication, and chopin's settled fields — the
 * shape both `answered` and a B4 replay return. An error indication can
 * never confirm (sol round-1 probe b) — chopin carries its typed refusals
 * INSIDE error responses, so returning "not a settle" here lets the
 * refusal mapping below interpret them. `choices` is checked against the
 * persisted answer by the caller (`expectedOptionIds`). */
function genuineSettle(
  http: number,
  body: (McpCallResult & { id?: unknown }) | undefined,
  expectedOptionIds: readonly string[],
): { kind: 'confirmed', result: unknown } | undefined {
  if (http >= 400 || !body) return undefined
  if (body.id !== CALL_ID || body.error || body.result?.isError) return undefined
  const structured = body.result?.structuredContent
  if (!structured || (structured.state !== 'answered' && structured.state !== 'replayed')) return undefined
  const settled = structured.settled as { choices?: unknown, by?: unknown, at?: unknown } | undefined
  if (
    !settled || typeof settled !== 'object'
    || !Array.isArray(settled.choices) || settled.choices.length === 0
    || typeof settled.by !== 'string' || settled.by.length === 0
    || typeof settled.at !== 'string' || settled.at.length === 0
  ) {
    return undefined
  }
  const choices = settled.choices as unknown[]
  const matches = choices.length === expectedOptionIds.length
    && expectedOptionIds.every(id => choices.includes(id))
  if (!matches) return undefined
  return { kind: 'confirmed', result: structured }
}

/** Map one chopin response to an outbox outcome. Never throws: any defect in
 * the response shape resolves unknown — evidence of a receiver we cannot
 * interpret, not a fabricated success. */
export function mapChopinOutcome(
  http: number,
  body: (McpCallResult & { id?: unknown }) | undefined,
  expectedOptionIds: readonly string[] = [],
): OutboxDispatchOutcome {
  const settle = genuineSettle(http, body, expectedOptionIds)
  if (settle) return settle
  if (http === 401 || http === 403) {
    // Chopin checks Origin before credentials, so a 403 can be either — name both.
    return { kind: 'failed', error: `chopin rejected the request (HTTP ${http} — check the bridge token and the Origin allowlist)` }
  }
  if (http >= 500) return { kind: 'unknown', detail: `chopin HTTP ${http}` }
  if (!body) return { kind: 'unknown', detail: `chopin returned an unreadable response (HTTP ${http})` }
  if (body.error) return { kind: 'unknown', detail: `chopin RPC error ${body.error.code}` }
  const structured = body.result?.structuredContent
  const refusal = structured && typeof structured.code === 'string'
    ? structured
    : body.result?.isError
    ? (() => {
        const text = body.result?.content?.find(part => part.type === 'text')?.text
        if (!text) return undefined
        try {
          const parsed = JSON.parse(text) as { code?: string, message?: string }
          return typeof parsed.code === 'string' ? parsed : undefined
        } catch {
          return undefined
        }
      })()
    : undefined
  if (refusal) {
    switch (refusal.code) {
      // Recoverable: the condition can clear, and chopin evaluates some of
      // these BEFORE its idempotency replay — a committed answer behind one
      // of these must stay resumable, never failed.
      case 'paused':
      case 'implementation-active':
      case 'draft-in-progress':
      case 'state-diverged':
      case 'document-unavailable':
      case 'unavailable':
        return { kind: 'unknown', detail: `chopin cannot act now: ${refusal.code}` }
      // Terminal: explicit evidence retry can never change.
      case 'idempotency-conflict':
      case 'unknown-decision':
      case 'not-allowed':
      case 'document-archived':
      case 'archived':
        return { kind: 'failed', error: `chopin refused: ${refusal.code}${refusal.message ? ` — ${refusal.message}` : ''}` }
      case 'resolved':
        // The decision is already settled — terminal for this op, and the
        // message names who settled it (evidence, not a guess).
        return { kind: 'failed', error: `chopin refused: resolved${refusal.message ? ` — ${refusal.message}` : ''}` }
      // `invalid` is ambiguous in chopin (input validation AND commit
      // failures); anything unrecognized is evidence we cannot interpret.
      default:
        return { kind: 'unknown', detail: `chopin refusal left unresolved: ${refusal.code}` }
    }
  }
  return { kind: 'unknown', detail: 'chopin response carried neither a settle nor a typed refusal' }
}

/** The A2 dispatcher over chopin's MCP surface. Throws
 * BridgeTransportConfigError (sanitized, never token material) on an
 * unusable credential. */
export function createChopinOutboxDispatcher(config: ChopinTransportConfig): OutboxDispatcher {
  if (!isValidBearerToken(config.token)) {
    throw new BridgeTransportConfigError('bridge token is empty or not a valid header value')
  }
  return async op => {
    if (op.targetSystem !== 'chopin') {
      return { kind: 'failed', error: `no chopin transport for target system ${op.targetSystem}` }
    }
    if (op.kind !== 'answer') {
      // Gate-2 approval is B1-direct by demo decision (no approve op is ever
      // enqueued); this branch exists so the transport lies about nothing.
      return { kind: 'failed', error: `op kind ${op.kind} has no chopin transport` }
    }
    const payload = op.payload as { tool?: unknown, arguments?: unknown } | null
    if (!payload || typeof payload.tool !== 'string' || payload.arguments === undefined) {
      return { kind: 'failed', error: 'persisted op payload is not a chopin tool call' }
    }
    if (payload.tool !== 'answer_decision') {
      return { kind: 'failed', error: `persisted op names unexpected tool ${payload.tool}` }
    }
    const args = payload.arguments as { optionIds?: unknown } | undefined
    const expectedOptionIds = Array.isArray(args?.optionIds) && args!.optionIds.every(id => typeof id === 'string')
      ? args!.optionIds as string[]
      : []
    try {
      const { http, body } = await chopinToolCall(config, payload.tool, payload.arguments)
      return mapChopinOutcome(http, body, expectedOptionIds)
    } catch {
      // FIXED diagnostic: exception text has carried credentials before
      // (Headers rejects malformed bearer values with the value in the
      // message) and the outbox persists details into publicly readable state.
      return { kind: 'unknown', detail: 'chopin unreachable' }
    }
  }
}

export type BridgeTransportWiring = {
  dispatcher?: OutboxDispatcher
  /** Fixed, sanitized reason the configured target is broken. Absent when
   * no target was configured at all (an intentional unset). */
  configError?: string
}

/** Env wiring. Token custody: `WD_CHOPIN_TOKEN_FILE` (a 0600 file) is
 * preferred; `WD_CHOPIN_TOKEN` is accepted for local demos. No
 * `WD_CHOPIN_URL` is an intentional unset — undefined, silent. A set-but-
 * broken configuration returns `configError` (fixed strings only) so the
 * console can distinguish "not configured" from "configured wrong". */
export function chopinTransportFromEnv(env: NodeJS.ProcessEnv = process.env): BridgeTransportWiring {
  const baseUrl = env.WD_CHOPIN_URL
  if (!baseUrl) return {}
  let token: string | undefined
  if (env.WD_CHOPIN_TOKEN_FILE) {
    let raw: string
    try {
      raw = readFileSync(env.WD_CHOPIN_TOKEN_FILE, 'utf8')
    } catch {
      return { configError: 'WD_CHOPIN_TOKEN_FILE is set but unreadable' }
    }
    token = raw.trim()
    if (token.length === 0) return { configError: 'bridge token file is empty' }
  } else if (env.WD_CHOPIN_TOKEN) {
    token = env.WD_CHOPIN_TOKEN
  } else {
    return { configError: 'WD_CHOPIN_URL is set without a bridge token (WD_CHOPIN_TOKEN_FILE / WD_CHOPIN_TOKEN)' }
  }
  try {
    return { dispatcher: createChopinOutboxDispatcher({ baseUrl, token, ...(env.WD_CHOPIN_ORIGIN ? { origin: env.WD_CHOPIN_ORIGIN } : {}) }) }
  } catch (error) {
    if (error instanceof BridgeTransportConfigError) return { configError: error.message }
    throw error
  }
}
