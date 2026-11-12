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
/** Claim ceiling for the agreement scan (review round 8, P2). Chopin's
 * pinned construction yields at most a handful; anything beyond this
 * refuses to conclude rather than skipping a late contradiction. */
const MAX_CLAIMS = 32
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
  /** Presence-checked (review round 3, P1): a JSON-RPC error member at all —
   * even explicit `null` beside a result — makes the envelope malformed. */
  error?: unknown
  result?: {
    isError?: unknown
    structuredContent?: { state?: string, code?: unknown, message?: unknown, settled?: unknown, [key: string]: unknown }
    content?: unknown
  }
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
  // A response that arrived but cannot be parsed is "unreadable", not
  // "unreachable" (review round 2, P3) — and its text never enters a
  // persisted diagnostic.
  let body: (McpCallResult & { id?: unknown, jsonrpc?: unknown }) | undefined
  try {
    const dataLine = text.split('\n').filter(line => line.startsWith('data:')).at(-1)
    body = dataLine
      ? JSON.parse(dataLine.slice(5).trim()) as McpCallResult
      : text.trim().startsWith('{')
      ? JSON.parse(text) as McpCallResult
      : undefined
  } catch {
    return { http: call.status, body: undefined }
  }
  return { http: call.status, body }
}

/** Whether the response carries a genuine settle: JSON-RPC 2.0 success for
 * the tools/call id on a 2xx response, an absent error member (even
 * explicit `null` — review round 3, P1), no error indication, no refusal
 * claim beside the settle (round 3, P1), malformed-free settled
 * attribution (round 4, P2: a nonblank actor and a timestamp in chopin's
 * emitted ISO-with-milliseconds format — `by: " "` / `at: "yesterday"` are
 * not evidence), and `choices` equal to the persisted answer. Any
 * RECOGNIZED settle state (`answered`/`replayed`) is verified here even
 * when incomplete, so its failure mode gets the precise
 * unverifiable-settle detail instead of the generic fallthrough. Bodies
 * with no recognized settle state return undefined and fall through to the
 * refusal mapping. */
function genuineSettle(
  http: number,
  body: (McpCallResult & { id?: unknown, jsonrpc?: unknown }) | undefined,
  expectedOptionIds: readonly string[],
): { confirmed: true, result: unknown } | { rejected: string } | undefined {
  const structured = body?.result?.structuredContent as
    | { state?: string, settled?: unknown, code?: unknown, [key: string]: unknown }
    | undefined
  const state = structured?.state
  if (state !== 'answered' && state !== 'replayed') return undefined
  const rejected = (detail: string) => ({ rejected: `unverifiable ${state} — ${detail}` })
  if (http < 200 || http >= 300) {
    return rejected(`settle evidence arrived on a non-2xx response (HTTP ${http})`)
  }
  if (body!.id !== CALL_ID || body!.jsonrpc !== '2.0') {
    return rejected('settle evidence is not correlated to the tool call')
  }
  if ('error' in body!) {
    return rejected('settle evidence arrived inside a JSON-RPC error envelope')
  }
  if (body!.result?.isError !== undefined && body!.result.isError !== false) {
    return rejected('settle evidence arrived inside an error indication')
  }
  if (typeof structured!.code === 'string') {
    return rejected('settle evidence claims both settlement and refusal')
  }
  const settled = structured!.settled as { choices?: unknown, by?: unknown, at?: unknown } | undefined
  // The timestamp check is format AND round-trip (review round 5, P2):
  // `2026-02-31T00:00:00.000Z` is format-shaped but calendar-impossible,
  // and JavaScript would silently normalize it — chopin's toISOString
  // emission always round-trips exactly.
  const atTime = typeof settled?.at === 'string' ? new Date(settled.at) : undefined
  if (
    !settled || typeof settled !== 'object'
    || !Array.isArray(settled.choices) || settled.choices.length === 0
    || typeof settled.by !== 'string' || settled.by.trim().length === 0
    || typeof settled.at !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(settled.at)
    || atTime === undefined || Number.isNaN(atTime.getTime()) || atTime.toISOString() !== settled.at
  ) {
    return rejected('settle evidence lacks a verifiable actor or timestamp')
  }
  const choices = settled.choices as unknown[]
  const matches = choices.length === expectedOptionIds.length
    && expectedOptionIds.every(id => choices.includes(id))
  if (!matches) return rejected('settle choices differ from the persisted answer')
  return { confirmed: true, result: structured }
}

/** Every recognized claim across ALL text blocks (review rounds 6–7):
 * chopin serializes the same evidence into structuredContent AND the text
 * result (pinned one-block construction), so the text is the second,
 * independent witness for contradiction checks — and beyond the pinned
 * shape, a second text block with a DIFFERENT recognized claim is
 * contradictory evidence too. A single object claiming both settlement and
 * refusal (code beside state) contributes BOTH claims, so the pairwise
 * comparison catches it. A `settled` member that is PRESENT but not a
 * plain object (null, string, number, array) marks the claim
 * settledMalformed (review round 7, P2) — omitted `settled` stays clean.
 * Ordinary prose and non-JSON blocks contribute nothing. */
function textClaims(body: (McpCallResult & { id?: unknown, jsonrpc?: unknown }) | undefined):
  Array<{ source: 'text', kind: 'refusal', code: string, message?: string } | { source: 'text', kind: 'settle', state: string, settled?: { choices?: unknown, by?: unknown, at?: unknown }, settledMalformed?: true }> {
  const content = body?.result?.content
  if (!Array.isArray(content)) return []
  const claims: Array<{ source: 'text', kind: 'refusal', code: string, message?: string } | { source: 'text', kind: 'settle', state: string, settled?: { choices?: unknown, by?: unknown, at?: unknown }, settledMalformed?: true }> = []
  for (const part of content) {
    if (part?.type !== 'text' || typeof part.text !== 'string') continue
    try {
      const parsed = JSON.parse(part.text) as Record<string, unknown>
      // One object claiming both settlement and refusal (code beside state)
      // contributes both claims — the pairwise comparison below treats it
      // as contradictory evidence whatever the structured side says.
      if (typeof parsed.code === 'string') {
        claims.push({ source: 'text', kind: 'refusal', code: parsed.code, ...(typeof parsed.message === 'string' ? { message: parsed.message } : {}) })
      }
      if (parsed.state === 'answered' || parsed.state === 'replayed') {
        if (parsed.settled === undefined) {
          claims.push({ source: 'text', kind: 'settle', state: parsed.state })
        } else if (parsed.settled !== null && typeof parsed.settled === 'object' && !Array.isArray(parsed.settled)) {
          claims.push({ source: 'text', kind: 'settle', state: parsed.state, settled: parsed.settled as { choices?: unknown, by?: unknown, at?: unknown } })
        } else {
          claims.push({ source: 'text', kind: 'settle', state: parsed.state, settledMalformed: true })
        }
      }
    } catch {
      continue
    }
  }
  return claims
}

/** Whether two settlement witnesses contradict. SYMMETRIC and
 * supply-aware (review round 8, P2): each side's supplied fields must be
 * well-typed, and values are compared only where BOTH witnesses supply
 * the field — a text settle omitting choices does not disagree with a
 * structured settle's choices. Omitted fields add no claim; present-but-
 * malformed fields (`choices: "B"`, `by: 17`, `at: null`) contradict. */
function textSettleContradicts(
  a: { choices?: unknown, by?: unknown, at?: unknown },
  b: { choices?: unknown, by?: unknown, at?: unknown },
): boolean {
  for (const side of [a, b]) {
    if (side.choices !== undefined && !Array.isArray(side.choices)) return true
    if (side.by !== undefined && typeof side.by !== 'string') return true
    if (side.at !== undefined && typeof side.at !== 'string') return true
  }
  if (Array.isArray(a.choices) && Array.isArray(b.choices)) {
    const aChoices = a.choices
    const sameChoices = aChoices.length === b.choices.length
      && b.choices.every(id => aChoices.includes(id))
    if (!sameChoices) return true
  }
  if (a.by !== undefined && b.by !== undefined && a.by !== b.by) return true
  if (a.at !== undefined && b.at !== undefined && a.at !== b.at) return true
  return false
}

/** Map one chopin response to an outbox outcome. Never throws: any defect in
 * the response shape resolves unknown — evidence of a receiver we cannot
 * interpret, not a fabricated success. */
export function mapChopinOutcome(
  http: number,
  body: (McpCallResult & { id?: unknown, jsonrpc?: unknown }) | undefined,
  expectedOptionIds: readonly string[] = [],
): OutboxDispatchOutcome {
  if (http === 401 || http === 403) {
    // Chopin checks Origin before credentials, so a 403 can be either — name both.
    return { kind: 'failed', error: `chopin rejected the request (HTTP ${http} — check the bridge token and the Origin allowlist)` }
  }
  if (http >= 500) return { kind: 'unknown', detail: `chopin HTTP ${http}` }
  if (!body) return { kind: 'unknown', detail: `chopin returned an unreadable response (HTTP ${http})` }
  // Envelope correlation (review round 2, P1-2): a body that is not the
  // tools/call response — e.g. the initialize reply replayed at us — must
  // never be interpreted as a settle or a terminal refusal, whatever codes
  // it carries.
  if (body.id !== CALL_ID || body.jsonrpc !== '2.0') {
    return { kind: 'unknown', detail: 'chopin response is not correlated to the tool call' }
  }
  // A JSON-RPC error member at all — even explicit null — means this body
  // carries an error envelope, whatever else it claims (round 3, P1).
  if ('error' in body) return { kind: 'unknown', detail: 'chopin response carried an error envelope' }
  const settle = genuineSettle(http, body, expectedOptionIds)
  if (settle && !('confirmed' in settle)) {
    // The structured settle state was recognized and failed verification:
    // the outcome is unknown with the precise reason, whatever the text
    // blocks claim — they cannot rescue evidence that failed its checks.
    return { kind: 'unknown', detail: settle.rejected }
  }
  const structured = body.result?.structuredContent
  const structuredCode = typeof structured?.code === 'string' ? structured.code : undefined
  const structuredMessage = typeof structured?.message === 'string' ? structured.message : undefined
  // ONE CLAIM LIST (review round 7, P1): the structured side's verified
  // settle, the structured side's refusal (under isError), and EVERY
  // recognized text claim — compared against each other pairwise before
  // any outcome is selected. Kinds disagreeing, refusal codes disagreeing,
  // settlement states disagreeing, malformed settled fields on any
  // witness, and witness attribution disagreeing are all the same thing:
  // contradictory evidence — unknown, never confirmed and never failed,
  // in any order.
  const claims: Array<
    | { source: 'structured' | 'text', kind: 'settle', state: string, settled?: { choices?: unknown, by?: unknown, at?: unknown }, settledMalformed?: true }
    | { source: 'structured' | 'text', kind: 'refusal', code: string, message?: string }
  > = []
  if (settle?.confirmed) {
    const settleResult = settle.result as { state: string, settled?: { choices: unknown[], by?: unknown, at?: unknown } }
    claims.push({ source: 'structured', kind: 'settle', state: settleResult.state, settled: settleResult.settled })
  }
  if (body.result?.isError === true && structuredCode !== undefined) {
    claims.push({ source: 'structured', kind: 'refusal', code: structuredCode, ...(structuredMessage !== undefined ? { message: structuredMessage } : {}) })
  }
  claims.push(...textClaims(body))
  // Enforced claim ceiling (review round 8, P2): an overflowing response
  // is uncorrelatable — unknown — so a later contradiction can never be
  // skipped by hitting the limit. Chopin's pinned one-block construction
  // yields at most a handful; anything beyond 32 refuses to conclude.
  if (claims.length > MAX_CLAIMS) {
    return { kind: 'unknown', detail: 'chopin response carried too many claims to correlate' }
  }
  for (let i = 0; i < claims.length; i++) {
    for (let j = i + 1; j < claims.length; j++) {
      const a = claims[i]!, b = claims[j]!
      if (a.kind !== b.kind) {
        return { kind: 'unknown', detail: 'contradictory settlement and refusal evidence in one response' }
      }
      if (a.kind === 'refusal') {
        // b.kind === 'refusal' by the kind equality above.
        if (b.kind === 'refusal' && b.code !== a.code) {
          return { kind: 'unknown', detail: 'contradictory refusal evidence in one response' }
        }
        continue
      }
      // Both settle claims.
      if (b.kind !== 'settle') continue
      if (a.state !== b.state) {
        return { kind: 'unknown', detail: `contradictory settlement state: ${a.source} claims ${a.state} vs ${b.source} claims ${b.state}` }
      }
      if (a.settledMalformed || b.settledMalformed) {
        return { kind: 'unknown', detail: 'contradictory settle attribution: a witness carried malformed settled fields' }
      }
      if (a.settled && b.settled && textSettleContradicts(a.settled, b.settled)) {
        return { kind: 'unknown', detail: 'contradictory settle attribution between witnesses' }
      }
    }
  }
  // Outcome selection from the internally consistent claim list. A text
  // refusal maps to a terminal outcome ONLY under chopin's isError marker
  // (review round 8, P1) — without it the code is unattributed evidence:
  // unknown. Structured refusal claims were admitted under that marker at
  // construction.
  if (settle?.confirmed) {
    return { kind: 'confirmed', result: settle.result }
  }
  const structuredRefusalClaim = claims.find(claim => claim.source === 'structured' && claim.kind === 'refusal')
  const textRefusalClaim = claims.find(claim => claim.source === 'text' && claim.kind === 'refusal')
  const refusalClaim = structuredRefusalClaim ?? (body.result?.isError === true ? textRefusalClaim : undefined)
  if (!refusalClaim || refusalClaim.kind !== 'refusal') {
    return { kind: 'unknown', detail: body.result?.isError === true
      ? 'chopin error response carried no interpretable refusal'
      : 'chopin response carried neither a settle nor a typed refusal' }
  }
  const message = typeof refusalClaim.message === 'string' ? refusalClaim.message.slice(0, 200) : undefined
  switch (refusalClaim.code) {
    // Recoverable: the condition can clear, and chopin evaluates some of
    // these BEFORE its idempotency replay — a committed answer behind one
    // of these must stay resumable, never failed.
    case "paused":
    case "implementation-active":
    case "draft-in-progress":
    case "state-diverged":
    case "document-unavailable":
    case "unavailable":
      return { kind: 'unknown', detail: `chopin cannot act now: ${refusalClaim.code}` }
    // Terminal: explicit evidence retry can never change.
    case "idempotency-conflict":
    case "unknown-decision":
    case "not-allowed":
    case "document-archived":
    case "archived":
      return { kind: 'failed', error: `chopin refused: ${refusalClaim.code}${message ? ` — ${message}` : ''}` }
    case "resolved":
      // The decision is already settled — terminal for this op, and the
      // message names who settled it (evidence, not a guess); bounded so a
      // receiver cannot inflate persisted diagnostics.
      return { kind: 'failed', error: `chopin refused: resolved${message ? ` — ${message}` : ''}` }
    // `invalid` is ambiguous in chopin (input validation AND commit
    // failures); anything unrecognized is evidence we cannot interpret —
    // and receiver-supplied diagnostics stay bounded (round 4, P3).
    default:
      return { kind: 'unknown', detail: `chopin refusal left unresolved: ${refusalClaim.code.slice(0, 100)}` }
  }
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
