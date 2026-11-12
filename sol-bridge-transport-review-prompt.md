# sol review — chopin outbox transport (who-decides): the A2 dispatcher over chopin's MCP

**Expected tool/model:** Codex CLI, current `gpt-6.1-sol`. **Expected mode:** Review mode — findings first, severity-ordered. **Fresh session.**

## Context

The bridge work demo's missing piece: A2 (outbox) shipped the dispatch *discipline* and the dispatcher *interface*, but no production transport existed — the outbox had nothing to hand ops to. This slice adds the chopin HTTP transport and wires it env-gated, so a console-recorded Gate-1 answer dispatches chopin's `answer_decision` with the exact persisted payload. Built for the full-dress rehearsal running today; review before the work demo.

## The slice

who-decides `86e8e4b` on `dev` (parent `d80aedd`). Diff: `git diff d80aedd..86e8e4b` in `~/src/gh-joe/who-decides`.

- `src/server/chopin-transport.ts` — `createChopinOutboxDispatcher(config)`: MCP initialize→initialized→tools/call (SSE-strip, session header), **exact-payload rule** (`payload.tool`/`payload.arguments` forwarded verbatim, never re-derived), outcome mapping: settle/replay → confirmed; typed refusals retry can't repair → failed; `document-unavailable` + network loss + 5xx + timeout → unknown (resume re-sends the same bytes; chopin's B4 idempotency replays); 401/403 → failed (credential, loud); malformed responses → unknown, never fabricated success. `approve` kind and foreign targetSystem refuse without touching the wire (Gate-2 is B1-direct by demo decision — no approve op is ever enqueued; the branch exists so the transport lies about nothing).
- `chopinTransportFromEnv` — env-gated wiring (`WD_CHOPIN_URL` + `WD_CHOPIN_TOKEN_FILE` 0600-preferred / `WD_CHOPIN_TOKEN`); unset = undefined (ops hold pending, visible in console state); unreadable token file = logged, never silent.
- `state.ts` — engine singleton wires the dispatcher from env; `package.json` gains `test:chopin-transport` in the chain.
- Tests (7): exact-payload forwarding + session handshake asserted; typed refusal → failed; unavailable + ECONNRESET → unknown; 401/500 mapping; non-answer kinds refuse off-wire; malformed responses never fabricate success; env custody rules.

**Gates at `86e8e4b`:** full who-decides suite all green (13 test files incl. the new 7), `tsc --noEmit` clean. Live context: chopin side is `69c2eebd` (B0/B2/B1/B4/B5 + D6–D9, upstream-synced) on `:8788`; the transport's confirmed path is exercised by the full-dress rehearsal today (evidence lands on WITS #1593).

## Asks (severity-ordered)

1. **Outcome mapping honesty.** Any chopin response shape that would map to the wrong outcome — especially refusals that retry CAN repair (should any current `failed` be `unknown`?) or settles your probing suggests we'd misread?
2. **Exact-payload rule.** Confirm nothing in the transport re-derives, refreshes, or normalizes the persisted payload (header/URL construction excepted).
3. **Env/custody.** The token handling (file-preferred, hash-free) vs the repo's hash discipline (`WD_BRIDGE_TOKEN_HASH` is the *intake* side) — any leakage class or misconfiguration trap?
4. **Wiring.** The engine-singleton env wiring + fail-soft (log + undefined) — visible enough, or should a misconfigured transport surface in console state like `agentDispatchError` does?

## Verdict

End with one line: `transport: approve | approve_with_findings | revise`.
