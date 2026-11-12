/* Chopin outbox transport (full-dress): the A2 dispatcher interface over
 * chopin's MCP surface.
 *
 * EXACT-PAYLOAD RULE (outbox.ts): the op's persisted payload is sent verbatim
 * — `payload.tool` names the MCP tool, `payload.arguments` is forwarded
 * untouched. Nothing is re-derived from a fresh read; if the target moved,
 * the receiver's typed refusal is the honest outcome.
 *
 * OUTCOME MAPPING (unknown stays unknown):
 *  - chopin settle/replay (state answered|replayed) → confirmed
 *  - typed refusals that retry can never repair → failed (evidence)
 *  - receiver-side "cannot act now" (unavailable) and any transport-level
 *    loss (network error, 5xx, timeout) → unknown; a resume re-sends the
 *    same bytes under the same op key and chopin's B4 idempotency replays
 *    the original result, which is the only way unknown becomes confirmed.
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

type McpCallResult = {
  result?: {
    isError?: boolean
    structuredContent?: { state?: string, code?: string, message?: string, [key: string]: unknown }
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
): Promise<{ http: number, body: McpCallResult | undefined }> {
  const fetchImpl = config.fetchImpl ?? fetch
  const base = config.baseUrl.replace(/\/$/, '')
  const origin = config.origin ?? config.baseUrl
  const headers = {
    'authorization': `Bearer ${config.token}`,
    'content-type': 'application/json',
    'accept': 'application/json, text/event-stream',
    'origin': origin,
  }
  const initHeaders = new Headers(headers)
  const init = await fetchImpl(`${base}/mcp`, {
    method: 'POST',
    headers: initHeaders,
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
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: args } }),
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

/** Map one chopin response to an outbox outcome. Never throws: any defect in
 * the response shape resolves unknown — evidence of a receiver we cannot
 * interpret, not a fabricated success. */
export function mapChopinOutcome(http: number, body: McpCallResult | undefined): OutboxDispatchOutcome {
  if (http === 401 || http === 403) {
    return { kind: 'failed', error: `chopin rejected the bridge credential (HTTP ${http})` }
  }
  if (http >= 500) return { kind: 'unknown', detail: `chopin HTTP ${http}` }
  if (!body) return { kind: 'unknown', detail: `chopin returned an unreadable response (HTTP ${http})` }
  if (body.error) return { kind: 'failed', error: `chopin RPC error ${body.error.code}: ${body.error.message}` }
  const structured = body.result?.structuredContent
  if (structured && (structured.state === 'answered' || structured.state === 'replayed')) {
    return { kind: 'confirmed', result: structured }
  }
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
          return { code: 'unparsed-refusal', message: text.slice(0, 300) }
        }
      })()
    : undefined
  if (refusal) {
    if (refusal.code === 'document-unavailable' || refusal.code === 'unavailable') {
      return { kind: 'unknown', detail: `chopin cannot act now: ${refusal.code}` }
    }
    return { kind: 'failed', error: `chopin refused: ${refusal.code}${refusal.message ? ` — ${refusal.message}` : ''}` }
  }
  return { kind: 'unknown', detail: 'chopin response carried neither a settle nor a typed refusal' }
}

/** The A2 dispatcher over chopin's MCP surface. */
export function createChopinOutboxDispatcher(config: ChopinTransportConfig): OutboxDispatcher {
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
    try {
      const { http, body } = await chopinToolCall(config, payload.tool, payload.arguments)
      return mapChopinOutcome(http, body)
    } catch (error) {
      return { kind: 'unknown', detail: `chopin unreachable: ${error instanceof Error ? error.message : String(error)}` }
    }
  }
}

/** Env wiring. Token custody: `WD_CHOPIN_TOKEN_FILE` (a 0600 file) is
 * preferred; `WD_CHOPIN_TOKEN` is accepted for local demos. Returns
 * undefined — with the reason logged, never silent — when the demo has not
 * configured a chopin target, so the outbox simply holds ops pending. */
export function chopinTransportFromEnv(env: NodeJS.ProcessEnv = process.env): OutboxDispatcher | undefined {
  const baseUrl = env.WD_CHOPIN_URL
  if (!baseUrl) return undefined
  let token: string | undefined
  if (env.WD_CHOPIN_TOKEN_FILE) {
    try {
      token = readFileSync(env.WD_CHOPIN_TOKEN_FILE, 'utf8').trim()
    } catch (error) {
      console.error('bridge: WD_CHOPIN_TOKEN_FILE is set but unreadable — bridge ops will stay pending:', error instanceof Error ? error.message : error)
      return undefined
    }
  } else if (env.WD_CHOPIN_TOKEN) {
    token = env.WD_CHOPIN_TOKEN
  } else {
    console.error('bridge: WD_CHOPIN_URL is set but no bridge token (WD_CHOPIN_TOKEN_FILE / WD_CHOPIN_TOKEN) — bridge ops will stay pending')
    return undefined
  }
  return createChopinOutboxDispatcher({ baseUrl, token, ...(env.WD_CHOPIN_ORIGIN ? { origin: env.WD_CHOPIN_ORIGIN } : {}) })
}
