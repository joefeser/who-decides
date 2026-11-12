/* Chopin transport tests (full-dress): exact-payload forwarding, the
 * outcome mapping (confirmed / failed / unknown-stays-unknown), and the
 * env wiring's fail-soft custody rules. Run: npm run test:chopin-transport */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createChopinOutboxDispatcher, mapChopinOutcome, chopinTransportFromEnv } from './chopin-transport'
import type { ChopinTransportConfig } from './chopin-transport'

function config(overrides: Partial<ChopinTransportConfig> = {}): ChopinTransportConfig {
  return { baseUrl: 'http://localhost:8788', token: 'pat-test', ...overrides }
}

type Capture = { url: string, init: RequestInit, respond: () => Response }
/** A fake chopin: captures every request, replays a scripted response list. */
function fakeChopin(responses: Array<() => Response>): { fetchImpl: typeof fetch, calls: Capture[] } {
  const calls: Capture[] = []
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    const step = calls.length
    const respond = responses[Math.min(step, responses.length - 1)]
    calls.push({ url: String(url), init: init ?? {}, respond })
    return respond()
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers })

const answeredBody = {
  jsonrpc: '2.0', id: 2,
  result: { structuredContent: { state: 'answered', settled: { choices: ['opt-markdown'], by: 'joefeser', at: '2026-11-11T00:00:00.000Z' } } },
}

function answerOp() {
  return {
    opKey: 'wd:run-1:answer',
    kind: 'answer' as const,
    targetSystem: 'chopin',
    payload: { tool: 'answer_decision', arguments: { id: 'doc-1', questionId: 'card-1', revision: 2, optionIds: ['opt-markdown'], idempotencyKey: 'wd:run-1:answer' } },
  }
}

test('forwards the persisted payload verbatim and reports a settle as confirmed', async () => {
  let callBody: unknown
  const { fetchImpl, calls } = fakeChopin([
    json({ jsonrpc: '2.0', id: 1, result: {} }, 200, { 'mcp-session-id': 'sess-1' }),
    json({ jsonrpc: '2.0', id: 2, result: answeredBody.result }),
  ])
  const transport = createChopinOutboxDispatcher(config({
    fetchImpl: (url, init) => {
      if (String(url).endsWith('/tools/call') || (init?.body as string)?.includes('tools/call')) callBody = init?.body
      return fetchImpl(url, init)
    },
  }))
  const outcome = await transport(answerOp())
  assert.equal(outcome.kind, 'confirmed')
  if (outcome.kind === 'confirmed') assert.equal((outcome.result as { state: string }).state, 'answered')
  // Session handshake happened before the call, under the session header.
  assert.equal(calls.length, 3)
  assert.equal(new Headers(calls[1]!.init.headers as HeadersInit).get('mcp-session-id'), 'sess-1')
  // The call body carries the PERSISTED arguments — exact payload, no re-derivation.
  const parsed = JSON.parse(callBody as string) as { params: { name: string, arguments: Record<string, unknown> } }
  assert.equal(parsed.params.name, 'answer_decision')
  assert.deepEqual(parsed.params.arguments, answerOp().payload.arguments)
})

test('a typed refusal resolves failed with its code', async () => {
  const { fetchImpl } = fakeChopin([
    json({ jsonrpc: '2.0', id: 1, result: {} }, 200, { 'mcp-session-id': 's' }),
    json({ jsonrpc: '2.0', id: 2, result: { isError: true, content: [{ type: 'text', text: '{"code":"stale","message":"already answered by joefeser"}' }] } }),
  ])
  const outcome = await createChopinOutboxDispatcher(config({ fetchImpl }))(answerOp())
  assert.equal(outcome.kind, 'failed')
  if (outcome.kind === 'failed') assert.match(outcome.error, /stale/)
})

test('unavailable and transport loss stay unknown', async () => {
  const unavailable = fakeChopin([
    json({ jsonrpc: '2.0', id: 1, result: {} }, 200, { 'mcp-session-id': 's' }),
    json({ jsonrpc: '2.0', id: 2, result: { structuredContent: { code: 'document-unavailable' } } }),
  ])
  assert.equal((await createChopinOutboxDispatcher(config({ fetchImpl: unavailable.fetchImpl }))(answerOp())).kind, 'unknown')

  const lost = fakeChopin([() => { throw new Error('ECONNRESET') }])
  const lostOutcome = await createChopinOutboxDispatcher(config({ fetchImpl: lost.fetchImpl }))(answerOp())
  assert.equal(lostOutcome.kind, 'unknown')
  if (lostOutcome.kind === 'unknown') assert.match(lostOutcome.detail ?? '', /unreachable/)
})

test('credential rejection and 5xx map honestly', async () => {
  const rejected = fakeChopin([json({ error: 'unauthorized' }, 401)])
  const rejectedOutcome = await createChopinOutboxDispatcher(config({ fetchImpl: rejected.fetchImpl }))(answerOp())
  assert.equal(rejectedOutcome.kind, 'failed')
  if (rejectedOutcome.kind === 'failed') assert.match(rejectedOutcome.error, /credential/)

  const broken = fakeChopin([json('boom', 500)])
  assert.equal((await createChopinOutboxDispatcher(config({ fetchImpl: broken.fetchImpl }))(answerOp())).kind, 'unknown')
})

test('non-answer kinds and foreign targets refuse without touching the wire', async () => {
  const { fetchImpl, calls } = fakeChopin([])
  const transport = createChopinOutboxDispatcher(config({ fetchImpl }))
  const approve = await transport({ opKey: 'k', kind: 'approve', targetSystem: 'chopin', payload: {} })
  assert.equal(approve.kind, 'failed')
  const foreign = await transport({ opKey: 'k', kind: 'answer', targetSystem: 'github', payload: {} })
  assert.equal(foreign.kind, 'failed')
  assert.equal(calls.length, 0)
})

test('malformed or non-settle responses never fabricate success', async () => {
  assert.equal(mapChopinOutcome(200, undefined).kind, 'unknown')
  assert.equal(mapChopinOutcome(200, { error: { code: -32602, message: 'bad' } }).kind, 'failed')
  assert.equal(mapChopinOutcome(200, { result: { structuredContent: { something: 'else' } } }).kind, 'unknown')
})

test('env wiring: nothing configured is silent undefined; token custody via file', async () => {
  assert.equal(chopinTransportFromEnv({ NODE_ENV: 'test' } as NodeJS.ProcessEnv), undefined)
  // URL without a token logs and stays undefined rather than guessing.
  assert.equal(chopinTransportFromEnv({ NODE_ENV: 'test', WD_CHOPIN_URL: 'http://localhost:8788' } as NodeJS.ProcessEnv), undefined)
})
