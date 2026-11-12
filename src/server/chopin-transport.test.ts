/* Chopin transport tests (full-dress, review round 1): exact-payload
 * forwarding, the CONFIRMATION CONTRACT (a settle is verified, not taken on
 * faith), the honest outcome mapping (recoverable refusals stay unknown;
 * failed reserves terminal evidence), credential hygiene (a malformed token
 * can neither construct the dispatcher nor leak through a diagnostic), and
 * the env wiring's unset-vs-broken distinction. Run: npm run
 * test:chopin-transport */
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  createChopinOutboxDispatcher, mapChopinOutcome, chopinTransportFromEnv,
  isValidBearerToken, BridgeTransportConfigError,
} from './chopin-transport'
import type { ChopinTransportConfig } from './chopin-transport'

const OPTION = 'opt-markdown'

function config(overrides: Partial<ChopinTransportConfig> = {}): ChopinTransportConfig {
  return { baseUrl: 'http://localhost:8788', token: 'pat-test', ...overrides }
}

type Capture = { url: string, init: RequestInit }
/** A fake chopin: captures every request, replays a scripted response list. */
function fakeChopin(responses: Array<() => Response>): { fetchImpl: typeof fetch, calls: Capture[] } {
  const calls: Capture[] = []
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    const step = calls.length
    const respond = responses[Math.min(step, responses.length - 1)]
    calls.push({ url: String(url), init: init ?? {} })
    return respond()
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers })

const settled = { choices: [OPTION], by: 'joefeser', at: '2026-11-11T00:00:00.000Z' }

function answerOp() {
  return {
    opKey: 'wd:run-1:answer',
    kind: 'answer' as const,
    targetSystem: 'chopin',
    payload: { tool: 'answer_decision', arguments: { id: 'doc-1', questionId: 'card-1', revision: 2, optionIds: [OPTION], idempotencyKey: 'wd:run-1:answer' } },
  }
}

function handshaken(...responses: Array<() => Response>) {
  return fakeChopin([
    json({ jsonrpc: '2.0', id: 1, result: {} }, 200, { 'mcp-session-id': 'sess-1' }),
    ...responses,
  ])
}

test('forwards the persisted payload verbatim and confirms a genuine settle', async () => {
  let callBody: unknown
  const { fetchImpl, calls } = handshaken(json({ jsonrpc: '2.0', id: 2, result: { structuredContent: { state: 'answered', settled } } }))
  const transport = createChopinOutboxDispatcher(config({
    fetchImpl: (url, init) => {
      if ((init?.body as string)?.includes('tools/call')) callBody = init?.body
      return fetchImpl(url, init)
    },
  }))
  const outcome = await transport(answerOp())
  assert.deepEqual(outcome, { kind: 'confirmed', result: { state: 'answered', settled } })
  assert.equal(calls.length, 3)
  assert.equal(new Headers(calls[1]!.init.headers as HeadersInit).get('mcp-session-id'), 'sess-1')
  const parsed = JSON.parse(callBody as string) as { params: { name: string, arguments: Record<string, unknown> } }
  assert.equal(parsed.params.name, 'answer_decision')
  assert.deepEqual(parsed.params.arguments, answerOp().payload.arguments)
})

test('a B4 replay with a full settle confirms; the state string alone never does', async () => {
  const replay = handshaken(json({ jsonrpc: '2.0', id: 2, result: { structuredContent: { state: 'replayed', settled } } }))
  assert.equal((await createChopinOutboxDispatcher(config({ fetchImpl: replay.fetchImpl }))(answerOp())).kind, 'confirmed')

  // sol round-1 probe (a): replayed with NO settled field — not confirmable.
  const bare = handshaken(json({ jsonrpc: '2.0', id: 2, result: { structuredContent: { state: 'replayed' } } }))
  assert.equal((await createChopinOutboxDispatcher(config({ fetchImpl: bare.fetchImpl }))(answerOp())).kind, 'unknown')

  // sol round-1 probe (b): an error indication carrying state "answered".
  const lying = handshaken(json({ jsonrpc: '2.0', id: 2, result: { isError: true, structuredContent: { state: 'answered', settled } } }))
  assert.equal((await createChopinOutboxDispatcher(config({ fetchImpl: lying.fetchImpl }))(answerOp())).kind, 'unknown')

  // A settle whose choices do not match the persisted answer is not ours.
  const foreign = handshaken(json({ jsonrpc: '2.0', id: 2, result: { structuredContent: { state: 'answered', settled: { ...settled, choices: ['opt-json'] } } } }))
  const foreignOutcome = await createChopinOutboxDispatcher(config({ fetchImpl: foreign.fetchImpl }))(answerOp())
  assert.equal(foreignOutcome.kind, 'unknown')
  if (foreignOutcome.kind === 'unknown') assert.match(foreignOutcome.detail ?? '', /choices differ/)

  // sol round-2 probes: settle-shaped bodies that fail envelope verification.
  const on300 = handshaken(json({ jsonrpc: '2.0', id: 2, result: { structuredContent: { state: 'answered', settled } } }, 300))
  const on300Outcome = await createChopinOutboxDispatcher(config({ fetchImpl: on300.fetchImpl }))(answerOp())
  assert.equal(on300Outcome.kind, 'unknown')
  if (on300Outcome.kind === 'unknown') assert.match(on300Outcome.detail ?? '', /non-2xx/)

  const noEnvelope = fakeChopin([json({ id: 2, result: { structuredContent: { state: 'answered', settled } } })])
  const noEnvelopeOutcome = await createChopinOutboxDispatcher(config({ fetchImpl: noEnvelope.fetchImpl }))(answerOp())
  assert.equal(noEnvelopeOutcome.kind, 'unknown')
  if (noEnvelopeOutcome.kind === 'unknown') assert.match(noEnvelopeOutcome.detail ?? '', /not correlated/)
})

test('only the tool call response is interpreted — initialize replies never refuse an op', async () => {
  // sol round-2 probe: a body correlated to the WRONG rpc (id 1, the
  // initialize response) carrying a terminal refusal must stay unknown.
  const wrongId = fakeChopin([
    json({ jsonrpc: '2.0', id: 1, result: {} }, 200, { 'mcp-session-id': 'sess-1' }),
    json({ jsonrpc: '2.0', id: 1, result: { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: 'resolved', message: 'already answered by joefeser' }) }] } }),
  ])
  const outcome = await createChopinOutboxDispatcher(config({ fetchImpl: wrongId.fetchImpl }))(answerOp())
  assert.equal(outcome.kind, 'unknown')
  if (outcome.kind === 'unknown') assert.match(outcome.detail ?? '', /not correlated/)

  // A correctly correlated error response still reaches the refusal switch.
  const rightId = handshaken(json({ jsonrpc: '2.0', id: 2, result: { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: 'resolved', message: 'already answered by joefeser' }) }] } }))
  const correlated = await createChopinOutboxDispatcher(config({ fetchImpl: rightId.fetchImpl }))(answerOp())
  assert.equal(correlated.kind, 'failed')
  if (correlated.kind === 'failed') assert.match(correlated.error, /already answered by joefeser/)
})

test('round-3 probes: error envelopes, settlement+refusal claims, marker-less codes, bare states', async () => {
  // sol round-3 probe (a): error member present (even null) beside a result.
  const errorNull = handshaken(json({ jsonrpc: '2.0', id: 2, error: null, result: { structuredContent: { state: 'answered', settled } } }))
  const errorNullOutcome = await createChopinOutboxDispatcher(config({ fetchImpl: errorNull.fetchImpl }))(answerOp())
  assert.equal(errorNullOutcome.kind, 'unknown')
  if (errorNullOutcome.kind === 'unknown') assert.match(errorNullOutcome.detail ?? '', /error envelope/)

  // sol round-3 probe (b): a result claiming settlement AND refusal.
  const both = handshaken(json({ jsonrpc: '2.0', id: 2, result: { structuredContent: { state: 'answered', settled, code: 'resolved' } } }))
  const bothOutcome = await createChopinOutboxDispatcher(config({ fetchImpl: both.fetchImpl }))(answerOp())
  assert.equal(bothOutcome.kind, 'unknown')
  if (bothOutcome.kind === 'unknown') assert.match(bothOutcome.detail ?? '', /settlement and refusal/)

  // sol round-3 probe (c): a bare structuredContent code WITHOUT isError is
  // unattributed evidence — unknown, never failed.
  const markerless = handshaken(json({ jsonrpc: '2.0', id: 2, result: { structuredContent: { code: 'resolved' } } }))
  const markerlessOutcome = await createChopinOutboxDispatcher(config({ fetchImpl: markerless.fetchImpl }))(answerOp())
  assert.equal(markerlessOutcome.kind, 'unknown')

  // sol round-3 probe (d): bare state without settled fields is classified
  // unverifiable, not the generic fallthrough.
  const bare = handshaken(json({ jsonrpc: '2.0', id: 2, result: { structuredContent: { state: 'answered' } } }))
  const bareOutcome = await createChopinOutboxDispatcher(config({ fetchImpl: bare.fetchImpl }))(answerOp())
  assert.equal(bareOutcome.kind, 'unknown')
  if (bareOutcome.kind === 'unknown') assert.match(bareOutcome.detail ?? '', /unverifiable answered/)

  // sol round-3 probe (e): isError with non-array content must not crash
  // into "chopin unreachable" — the response arrived; say so.
  const emptyContent = handshaken(json({ jsonrpc: '2.0', id: 2, result: { isError: true, content: {} } }))
  const emptyOutcome = await createChopinOutboxDispatcher(config({ fetchImpl: emptyContent.fetchImpl }))(answerOp())
  assert.equal(emptyOutcome.kind, 'unknown')
  if (emptyOutcome.kind === 'unknown') assert.match(emptyOutcome.detail ?? '', /no interpretable refusal/)
  assert.notEqual(emptyOutcome.detail, 'chopin unreachable')

  // Recoverable refusals via structuredContent.code under isError still map.
  const structuredRefusal = handshaken(json({ jsonrpc: '2.0', id: 2, result: { isError: true, structuredContent: { code: 'paused' } } }))
  assert.equal((await createChopinOutboxDispatcher(config({ fetchImpl: structuredRefusal.fetchImpl }))(answerOp())).kind, 'unknown')

  // Terminal refusal messages are bounded in persisted diagnostics.
  const longMessage = handshaken(json({ jsonrpc: '2.0', id: 2, result: { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: 'resolved', message: 'x'.repeat(500) }) }] } }))
  const bounded = await createChopinOutboxDispatcher(config({ fetchImpl: longMessage.fetchImpl }))(answerOp())
  assert.equal(bounded.kind, 'failed')
  if (bounded.kind === 'failed') assert.ok(bounded.error.length < 300)
})

test('an arrived-but-unparseable response is unreadable, not unreachable', async () => {
  const garbage = fakeChopin([json('this is not json at all')])
  const outcome = await createChopinOutboxDispatcher(config({ fetchImpl: garbage.fetchImpl }))(answerOp())
  assert.deepEqual(outcome, { kind: 'unknown', detail: 'chopin returned an unreadable response (HTTP 200)' })
})

test('recoverable refusals stay unknown — a committed answer behind them resumes', async () => {
  for (const code of ['paused', 'implementation-active', 'draft-in-progress', 'state-diverged', 'document-unavailable']) {
    const fake = handshaken(json({ jsonrpc: '2.0', id: 2, result: { isError: true, content: [{ type: 'text', text: JSON.stringify({ code }) }] } }))
    const outcome = await createChopinOutboxDispatcher(config({ fetchImpl: fake.fetchImpl }))(answerOp())
    assert.equal(outcome.kind, 'unknown', `code ${code} must stay resumable`)
  }
})

test('terminal refusals resolve failed; ambiguous ones never do', async () => {
  const refused = async (code: string, message?: string) => {
    const fake = handshaken(json({ jsonrpc: '2.0', id: 2, result: { isError: true, content: [{ type: 'text', text: JSON.stringify({ code, message }) }] } }))
    return createChopinOutboxDispatcher(config({ fetchImpl: fake.fetchImpl }))(answerOp())
  }
  const conflict = await refused('idempotency-conflict')
  assert.equal(conflict.kind, 'failed')
  const resolved = await refused('resolved', 'already answered by joefeser')
  assert.equal(resolved.kind, 'failed')
  if (resolved.kind === 'failed') assert.match(resolved.error, /already answered by joefeser/)
  // `invalid` is ambiguous in chopin (validation AND commit errors) — unknown.
  assert.equal((await refused('invalid')).kind, 'unknown')
  // Unrecognized codes and unparseable text are evidence we cannot interpret.
  assert.equal((await refused('some-future-code')).kind, 'unknown')
  const unparseable = handshaken(json({ jsonrpc: '2.0', id: 2, result: { isError: true, content: [{ type: 'text', text: 'the plan moved underneath us' }] } }))
  assert.equal((await createChopinOutboxDispatcher(config({ fetchImpl: unparseable.fetchImpl }))(answerOp())).kind, 'unknown')
  // RPC-level errors are unknown, never failed.
  const rpc = handshaken(json({ jsonrpc: '2.0', id: 2, error: { code: -32602, message: 'bad params' } }))
  assert.equal((await createChopinOutboxDispatcher(config({ fetchImpl: rpc.fetchImpl }))(answerOp())).kind, 'unknown')
  // Receiver-supplied diagnostics stay bounded — even the unknown-code echo.
  const longCode = await refused('x'.repeat(500))
  assert.equal(longCode.kind, 'unknown')
  if (longCode.kind === 'unknown') assert.ok((longCode.detail ?? '').length < 200, 'unknown-code echo must be bounded')
})

test('round-4 probes: contradictory witnesses and malformed attribution never settle', async () => {
  // sol round-4 probe (a): a valid structured settle paired with a text
  // refusal — chopin serializes the same value into both, so disagreement
  // is malformed evidence, never a confirmation.
  const settlePlusRefusal = handshaken(json({ jsonrpc: '2.0', id: 2, result: {
    structuredContent: { state: 'answered', settled },
    content: [{ type: 'text', text: JSON.stringify({ code: 'paused' }) }],
  } }))
  const contradictA = await createChopinOutboxDispatcher(config({ fetchImpl: settlePlusRefusal.fetchImpl }))(answerOp())
  assert.equal(contradictA.kind, 'unknown')
  if (contradictA.kind === 'unknown') assert.match(contradictA.detail ?? '', /contradictory/)

  // sol round-4 probe (b): isError with structured `resolved` and text
  // `paused` — disagreement between the two witnesses must stay resumable,
  // never failed.
  const contradictB = handshaken(json({ jsonrpc: '2.0', id: 2, result: {
    isError: true,
    structuredContent: { code: 'resolved' },
    content: [{ type: 'text', text: JSON.stringify({ code: 'paused' }) }],
  } }))
  const contradictBOutcome = await createChopinOutboxDispatcher(config({ fetchImpl: contradictB.fetchImpl }))(answerOp())
  assert.equal(contradictBOutcome.kind, 'unknown')
  if (contradictBOutcome.kind === 'unknown') assert.match(contradictBOutcome.detail ?? '', /contradictory/)

  // Witnesses agreeing still map: isError with BOTH witnesses carrying the
  // same recoverable code.
  const agreeing = handshaken(json({ jsonrpc: '2.0', id: 2, result: {
    isError: true,
    structuredContent: { code: 'paused' },
    content: [{ type: 'text', text: JSON.stringify({ code: 'paused' }) }],
  } }))
  const agreeingOutcome = await createChopinOutboxDispatcher(config({ fetchImpl: agreeing.fetchImpl }))(answerOp())
  assert.equal(agreeingOutcome.kind, 'unknown')
  if (agreeingOutcome.kind === 'unknown') assert.match(agreeingOutcome.detail ?? '', /cannot act now: paused/)

  // A genuine settle whose text mirrors it without a refusal still confirms.
  const mirrored = handshaken(json({ jsonrpc: '2.0', id: 2, result: {
    structuredContent: { state: 'answered', settled },
    content: [{ type: 'text', text: JSON.stringify({ state: 'answered' }) }],
  } }))
  const mirroredOutcome = await createChopinOutboxDispatcher(config({ fetchImpl: mirrored.fetchImpl }))(answerOp())
  assert.equal(mirroredOutcome.kind, 'confirmed')

  // sol round-5 probes: text SETTLEMENT witnesses participate in the
  // comparison — chopin's pinned construction serializes the same value
  // into both fields, so a text settlement that disagrees with the
  // structured one is malformed evidence.
  // (1) isError + structured `resolved` + a full text `answered` settle:
  // refusal-claims-settlement, never failed.
  const refusalVsSettle = handshaken(json({ jsonrpc: '2.0', id: 2, result: {
    isError: true,
    structuredContent: { code: 'resolved' },
    content: [{ type: 'text', text: JSON.stringify({ state: 'answered', settled }) }],
  } }))
  const refusalVsSettleOutcome = await createChopinOutboxDispatcher(config({ fetchImpl: refusalVsSettle.fetchImpl }))(answerOp())
  assert.equal(refusalVsSettleOutcome.kind, 'unknown')
  if (refusalVsSettleOutcome.kind === 'unknown') assert.match(refusalVsSettleOutcome.detail ?? '', /settlement and refusal/)

  // (2) structured settle for choice A + text settle for choice B:
  // contradictory attribution, never confirmed.
  const settleVsSettle = handshaken(json({ jsonrpc: '2.0', id: 2, result: {
    structuredContent: { state: 'answered', settled },
    content: [{ type: 'text', text: JSON.stringify({ state: 'answered', settled: { ...settled, choices: ['opt-json'] } }) }],
  } }))
  const settleVsSettleOutcome = await createChopinOutboxDispatcher(config({ fetchImpl: settleVsSettle.fetchImpl }))(answerOp())
  assert.equal(settleVsSettleOutcome.kind, 'unknown')
  if (settleVsSettleOutcome.kind === 'unknown') assert.match(settleVsSettleOutcome.detail ?? '', /attribution/)

  // (3) a text settlement that AGREES with the structured settle confirms.
  const agreeingText = handshaken(json({ jsonrpc: '2.0', id: 2, result: {
    structuredContent: { state: 'answered', settled },
    content: [{ type: 'text', text: JSON.stringify({ state: 'answered', settled }) }],
  } }))
  const agreeingTextOutcome = await createChopinOutboxDispatcher(config({ fetchImpl: agreeingText.fetchImpl }))(answerOp())
  assert.equal(agreeingTextOutcome.kind, 'confirmed')

  // sol round-5 probe (P2): a calendar-impossible timestamp matching the
  // regex (Feb 31 — JS normalizes it to March) is unverifiable.
  const february31 = handshaken(json({ jsonrpc: '2.0', id: 2, result: { structuredContent: { state: 'answered', settled: { ...settled, at: '2026-02-31T00:00:00.000Z' } } } }))
  const february31Outcome = await createChopinOutboxDispatcher(config({ fetchImpl: february31.fetchImpl }))(answerOp())
  assert.equal(february31Outcome.kind, 'unknown')
  if (february31Outcome.kind === 'unknown') assert.match(february31Outcome.detail ?? '', /actor or timestamp/)

  // sol round-5 ruling: a code-less or state-only text beside a genuine
  // settle adds no competing claim and confirms.
  const stateOnlyText = handshaken(json({ jsonrpc: '2.0', id: 2, result: {
    structuredContent: { state: 'answered', settled },
    content: [{ type: 'text', text: JSON.stringify({ state: 'answered' }) }],
  } }))
  assert.equal((await createChopinOutboxDispatcher(config({ fetchImpl: stateOnlyText.fetchImpl }))(answerOp())).kind, 'confirmed')

  // sol round-4 probe (P2): malformed attribution — blank actor, or an
  // unparseable timestamp — is unverifiable, never confirmed.
  const blankBy = handshaken(json({ jsonrpc: '2.0', id: 2, result: { structuredContent: { state: 'answered', settled: { ...settled, by: ' ' } } } }))
  assert.equal((await createChopinOutboxDispatcher(config({ fetchImpl: blankBy.fetchImpl }))(answerOp())).kind, 'unknown')
  const yesterdayAt = handshaken(json({ jsonrpc: '2.0', id: 2, result: { structuredContent: { state: 'answered', settled: { ...settled, at: 'yesterday' } } } }))
  const yesterdayOutcome = await createChopinOutboxDispatcher(config({ fetchImpl: yesterdayAt.fetchImpl }))(answerOp())
  assert.equal(yesterdayOutcome.kind, 'unknown')
  if (yesterdayOutcome.kind === 'unknown') assert.match(yesterdayOutcome.detail ?? '', /actor or timestamp/)
})

test('round-6 probes: both-claim objects, malformed text fields, multi-block comparison, bounded echoes', async () => {
  // sol round-6 probe (P1): ONE text object claiming BOTH refusal and
  // settlement — with isError + structured code `resolved` (matching the
  // code half), the settlement half must still contradict. Was `failed`.
  const bothClaim = handshaken(json({ jsonrpc: '2.0', id: 2, result: {
    isError: true,
    structuredContent: { code: 'resolved' },
    content: [{ type: 'text', text: JSON.stringify({ code: 'resolved', state: 'answered', settled }) }],
  } }))
  const bothOutcome = await createChopinOutboxDispatcher(config({ fetchImpl: bothClaim.fetchImpl }))(answerOp())
  assert.equal(bothOutcome.kind, 'unknown')
  if (bothOutcome.kind === 'unknown') assert.match(bothOutcome.detail ?? '', /settlement and refusal/)

  // sol round-6 probe (P2): present-but-malformed text settled fields
  // (choices not an array, by a number, at null) contradict — the
  // comparator must not skip them for having the wrong type.
  const malformedFields = handshaken(json({ jsonrpc: '2.0', id: 2, result: {
    structuredContent: { state: 'answered', settled },
    content: [{ type: 'text', text: JSON.stringify({ state: 'answered', settled: { choices: 'B', by: 17, at: null } }) }],
  } }))
  const malformedOutcome = await createChopinOutboxDispatcher(config({ fetchImpl: malformedFields.fetchImpl }))(answerOp())
  assert.equal(malformedOutcome.kind, 'unknown')
  if (malformedOutcome.kind === 'unknown') assert.match(malformedOutcome.detail ?? '', /attribution/)

  // sol round-6 probe (P3): the contradictory detail stays bounded even
  // when the structured code is 500 characters.
  const longCode = handshaken(json({ jsonrpc: '2.0', id: 2, result: {
    isError: true,
    structuredContent: { code: 'x'.repeat(500) },
    content: [{ type: 'text', text: JSON.stringify({ state: 'answered', settled }) }],
  } }))
  const longCodeOutcome = await createChopinOutboxDispatcher(config({ fetchImpl: longCode.fetchImpl }))(answerOp())
  assert.equal(longCodeOutcome.kind, 'unknown')
  if (longCodeOutcome.kind === 'unknown') assert.ok((longCodeOutcome.detail ?? '').length < 300, 'contradiction detail must be bounded')

  // sol round-6 multi-block ruling: a SECOND text block carrying a
  // different recognized claim (a refusal beside an agreeing settlement)
  // is contradictory evidence.
  const secondBlock = handshaken(json({ jsonrpc: '2.0', id: 2, result: {
    structuredContent: { state: 'answered', settled },
    content: [
      { type: 'text', text: JSON.stringify({ state: 'answered', settled }) },
      { type: 'text', text: JSON.stringify({ code: 'resolved' }) },
    ],
  } }))
  const secondBlockOutcome = await createChopinOutboxDispatcher(config({ fetchImpl: secondBlock.fetchImpl }))(answerOp())
  assert.equal(secondBlockOutcome.kind, 'unknown')
  if (secondBlockOutcome.kind === 'unknown') assert.match(secondBlockOutcome.detail ?? '', /settlement and refusal/)

  // Agreeing repeats in a second block leave the outcome unchanged.
  const agreeingRepeat = handshaken(json({ jsonrpc: '2.0', id: 2, result: {
    structuredContent: { state: 'answered', settled },
    content: [
      { type: 'text', text: JSON.stringify({ state: 'answered', settled }) },
      { type: 'text', text: JSON.stringify({ state: 'answered', settled }) },
    ],
  } }))
  assert.equal((await createChopinOutboxDispatcher(config({ fetchImpl: agreeingRepeat.fetchImpl }))(answerOp())).kind, 'confirmed')

  // Ordinary prose in a second block adds no claim.
  const proseSecond = handshaken(json({ jsonrpc: '2.0', id: 2, result: {
    structuredContent: { state: 'answered', settled },
    content: [
      { type: 'text', text: JSON.stringify({ state: 'answered', settled }) },
      { type: 'text', text: 'just prose, not JSON' },
    ],
  } }))
  assert.equal((await createChopinOutboxDispatcher(config({ fetchImpl: proseSecond.fetchImpl }))(answerOp())).kind, 'confirmed')
})

test('round-8 probes: markerless text refusals, partial witnesses, claim ceiling', async () => {
  // sol round-8 probe (P1): a text refusal WITHOUT isError is unattributed
  // evidence — unknown, never failed — whether alone or mirrored in
  // structuredContent.
  const markerlessText = handshaken(json({ jsonrpc: '2.0', id: 2, result: {
    content: [{ type: 'text', text: JSON.stringify({ code: 'resolved' }) }],
  } }))
  const markerlessOutcome = await createChopinOutboxDispatcher(config({ fetchImpl: markerlessText.fetchImpl }))(answerOp())
  assert.equal(markerlessOutcome.kind, 'unknown')
  if (markerlessOutcome.kind === 'unknown') assert.match(markerlessOutcome.detail ?? '', /neither a settle nor a typed refusal/)

  const markerlessMirrored = handshaken(json({ jsonrpc: '2.0', id: 2, result: {
    isError: false,
    structuredContent: { code: 'resolved' },
    content: [{ type: 'text', text: JSON.stringify({ code: 'resolved' }) }],
  } }))
  const mirroredOutcome = await createChopinOutboxDispatcher(config({ fetchImpl: markerlessMirrored.fetchImpl }))(answerOp())
  assert.equal(mirroredOutcome.kind, 'unknown')

  // sol round-8 probe (P2): PARTIAL text settlements that agree confirm —
  // values compare only where both witnesses supply the field.
  const partialBy = handshaken(json({ jsonrpc: '2.0', id: 2, result: {
    structuredContent: { state: 'answered', settled: { choices: [OPTION], by: 'joe', at: '2026-11-11T00:00:00.000Z' } },
    content: [{ type: 'text', text: JSON.stringify({ state: 'answered', settled: { by: 'joe' } }) }],
  } }))
  assert.equal((await createChopinOutboxDispatcher(config({ fetchImpl: partialBy.fetchImpl }))(answerOp())).kind, 'confirmed')

  const emptySettled = handshaken(json({ jsonrpc: '2.0', id: 2, result: {
    structuredContent: { state: 'answered', settled: { choices: [OPTION], by: 'joe', at: '2026-11-11T00:00:00.000Z' } },
    content: [{ type: 'text', text: JSON.stringify({ state: 'answered', settled: {} }) }],
  } }))
  assert.equal((await createChopinOutboxDispatcher(config({ fetchImpl: emptySettled.fetchImpl }))(answerOp())).kind, 'confirmed')

  const choicesOnly = handshaken(json({ jsonrpc: '2.0', id: 2, result: {
    structuredContent: { state: 'answered', settled: { choices: [OPTION], by: 'joe', at: '2026-11-11T00:00:00.000Z' } },
    content: [{ type: 'text', text: JSON.stringify({ state: 'answered', settled: { choices: [OPTION] } }) }],
  } }))
  assert.equal((await createChopinOutboxDispatcher(config({ fetchImpl: choicesOnly.fetchImpl }))(answerOp())).kind, 'confirmed')

  // But a supplied field with the WRONG VALUE still contradicts.
  const differingBy = handshaken(json({ jsonrpc: '2.0', id: 2, result: {
    structuredContent: { state: 'answered', settled: { choices: [OPTION], by: 'joe', at: '2026-11-11T00:00:00.000Z' } },
    content: [{ type: 'text', text: JSON.stringify({ state: 'answered', settled: { by: 'someone-else' } }) }],
  } }))
  const differingOutcome = await createChopinOutboxDispatcher(config({ fetchImpl: differingBy.fetchImpl }))(answerOp())
  assert.equal(differingOutcome.kind, 'unknown')
  if (differingOutcome.kind === 'unknown') assert.match(differingOutcome.detail ?? '', /attribution/)

  // sol round-8 probe (P2): an OVERFLOWING response (33 claims) is
  // uncorrelatable — unknown with a bounded detail, never a conclusion
  // that skipped a late contradiction.
  const manyBlocks = Array.from({ length: 33 }, (_, index) => ({
    type: 'text',
    text: JSON.stringify(index % 2 === 0 ? { state: 'answered', settled } : { code: 'paused' }),
  }))
  const overflow = fakeChopin([
    json({ jsonrpc: '2.0', id: 1, result: {} }, 200, { 'mcp-session-id': 'sess-1' }),
    json({ jsonrpc: '2.0', id: 2, result: { structuredContent: { state: 'answered', settled }, content: manyBlocks } }),
  ])
  const overflowOutcome = await createChopinOutboxDispatcher(config({ fetchImpl: overflow.fetchImpl }))(answerOp())
  assert.equal(overflowOutcome.kind, 'unknown')
  if (overflowOutcome.kind === 'unknown') assert.match(overflowOutcome.detail ?? '', /too many claims/)
})

test('a malformed credential cannot construct the dispatcher nor leak through a diagnostic', async () => {
  assert.equal(isValidBearerToken(''), false)
  assert.equal(isValidBearerToken('  '), false)
  assert.equal(isValidBearerToken('pat\nwith-newline'), false)
  assert.equal(isValidBearerToken('pat\twith-tab'), false)
  assert.equal(isValidBearerToken('github_pat_valid'), true)
  assert.throws(() => createChopinOutboxDispatcher(config({ token: 'bad\ntoken' })), BridgeTransportConfigError)
  // Transport loss carries a FIXED diagnostic — the exception text (which
  // once contained the bearer) never reaches persisted state.
  const lost = fakeChopin([() => { throw new TypeError('Failed to parse header value') }])
  const outcome = await createChopinOutboxDispatcher(config({ fetchImpl: lost.fetchImpl }))(answerOp())
  assert.deepEqual(outcome, { kind: 'unknown', detail: 'chopin unreachable' })
})

test('credential rejection and 5xx map honestly; 403 names both candidate causes', async () => {
  const rejected = fakeChopin([json({ error: 'unauthorized' }, 401)])
  const rejectedOutcome = await createChopinOutboxDispatcher(config({ fetchImpl: rejected.fetchImpl }))(answerOp())
  assert.equal(rejectedOutcome.kind, 'failed')

  const forbidden = fakeChopin([json('origin not allowed', 403)])
  const forbiddenOutcome = await createChopinOutboxDispatcher(config({ fetchImpl: forbidden.fetchImpl }))(answerOp())
  assert.equal(forbiddenOutcome.kind, 'failed')
  if (forbiddenOutcome.kind === 'failed') assert.match(forbiddenOutcome.error, /token and the Origin/)

  const broken = fakeChopin([json('boom', 500)])
  assert.equal((await createChopinOutboxDispatcher(config({ fetchImpl: broken.fetchImpl }))(answerOp())).kind, 'unknown')
})

test('non-answer kinds, foreign targets, and unexpected tools refuse without touching the wire', async () => {
  const { fetchImpl, calls } = fakeChopin([])
  const transport = createChopinOutboxDispatcher(config({ fetchImpl }))
  const approve = await transport({ opKey: 'k', kind: 'approve', targetSystem: 'chopin', payload: {} })
  assert.equal(approve.kind, 'failed')
  const foreign = await transport({ opKey: 'k', kind: 'answer', targetSystem: 'github', payload: {} })
  assert.equal(foreign.kind, 'failed')
  const wrongTool = await transport({ opKey: 'k', kind: 'answer', targetSystem: 'chopin', payload: { tool: 'start_implementation', arguments: {} } })
  assert.equal(wrongTool.kind, 'failed')
  if (wrongTool.kind === 'failed') assert.match(wrongTool.error, /unexpected tool/)
  assert.equal(calls.length, 0)
})

test('malformed or non-settle responses never fabricate success', async () => {
  assert.equal(mapChopinOutcome(200, undefined).kind, 'unknown')
  assert.equal(mapChopinOutcome(200, { id: 2, error: { code: -32602, message: 'bad' } }).kind, 'unknown')
  assert.equal(mapChopinOutcome(200, { id: 2, result: { structuredContent: { something: 'else' } } }).kind, 'unknown')
})

test('env wiring: unset is silent, broken is a fixed configError, custody via file', async () => {
  assert.deepEqual(chopinTransportFromEnv({ NODE_ENV: 'test' } as NodeJS.ProcessEnv), {})
  // URL without a token: broken configuration, distinguishable from unset.
  const noToken = chopinTransportFromEnv({ NODE_ENV: 'test', WD_CHOPIN_URL: 'http://localhost:8788' } as NodeJS.ProcessEnv)
  assert.equal(noToken.dispatcher, undefined)
  assert.match(noToken.configError ?? '', /without a bridge token/)

  // A real 0600 file wires the dispatcher.
  const dir = mkdtempSync(path.join(tmpdir(), 'wd-transport-env-'))
  const file = path.join(dir, 'bridge-token')
  writeFileSync(file, 'github_pat_file_token\n', { mode: 0o600 })
  const wired = chopinTransportFromEnv({ NODE_ENV: 'test', WD_CHOPIN_URL: 'http://localhost:8788', WD_CHOPIN_TOKEN_FILE: file } as NodeJS.ProcessEnv)
  assert.equal(wired.configError, undefined)
  assert.notEqual(wired.dispatcher, undefined)

  // A whitespace-only file is broken configuration, not an empty bearer.
  writeFileSync(file, '   \n', { mode: 0o600 })
  const empty = chopinTransportFromEnv({ NODE_ENV: 'test', WD_CHOPIN_URL: 'http://localhost:8788', WD_CHOPIN_TOKEN_FILE: file } as NodeJS.ProcessEnv)
  assert.equal(empty.dispatcher, undefined)
  assert.match(empty.configError ?? '', /empty/)

  // An unreadable file is broken configuration with the reason.
  writeFileSync(file, 'github_pat_file_token\n', { mode: 0o600 })
  chmodSync(file, 0o000)
  try {
    const unreadable = chopinTransportFromEnv({ NODE_ENV: 'test', WD_CHOPIN_URL: 'http://localhost:8788', WD_CHOPIN_TOKEN_FILE: file } as NodeJS.ProcessEnv)
    assert.equal(unreadable.dispatcher, undefined)
    assert.match(unreadable.configError ?? '', /unreadable/)
  } finally {
    chmodSync(file, 0o600)
    rmSync(dir, { recursive: true, force: true })
  }
})
