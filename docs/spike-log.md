# Spike Log

Day-1 record for the RULING M1–M4 gates. Design decisions live in the WITS
governed-talk debate record; this file records implementation evidence only.

## Day 1 — 2026-09-03 (partial)

### SDK identification

- The Strands TypeScript SDK is **`@strands-agents/sdk@1.16.0`** (org-scoped).
- The unscoped npm package `strands-agents@0.0.1` is NOT the AWS SDK — do not install it.
- Peer dependency: the `openai` package must be installed explicitly for the
  OpenAI provider path (`ERR_MODULE_NOT_FOUND` otherwise).
- OpenAI-compatible configuration: `new OpenAIModel({ api: 'chat', modelId,
  apiKey, clientConfig: { baseURL } })`.

### Finding: the TS SDK ships a human-in-the-loop interrupt primitive

`@strands-agents/sdk` exports `Interrupt`, `InterruptSource`,
`InterruptResponseContent` (`dist/src/interrupt.d.ts`). Documented flow:

1. Hook or tool calls `event.interrupt()` / `context.interrupt()`
2. If resuming (response exists), the response is returned
3. Otherwise, agent execution halts with `stopReason: 'interrupt'`
4. User resumes by invoking the agent with `interruptResponse` content blocks
5. On resume, `interrupt()` returns the user's response

The SDK also ships `StateStore`, `Snapshot`/`TakeSnapshotOptions`, and the
interrupt type records deserialization from snapshots ("defaults to `'hook'`"),
suggesting interrupts persist across snapshot restore.

A second resume primitive exists: `InvokeArgs` includes **`CheckpointResumeContent`**
("Resume payload for a checkpointing agent", marked `@experimental`), and
`AgentResult` carries `interrupts?: Interrupt[]` and `checkpoint?: Checkpoint`.
Both primitives are M1-conditional evidence; neither is tested against the M1
bar (restart survival, exact control-flow state, idempotent response).

**Relevance:** RULING M1 made mid-run pause out of scope "unless Strands ships
a checkpoint primitive inside the build window." This appears to be that
primitive, in the TS SDK, shipped. Whether it meets the M1 bar (survives
process restart, restores exact pending control-flow/tool state, idempotent
human response, repeatable within the cap) is UNTESTED. Reopening M1 is the
human owner's call, not the principals'. Default remains terminal + seeded
resume per the ruling until he rules otherwise.

### Escape-hatch smoke status

**PASSED (2026-09-03).** Receipt: `passed: true`, reply "Operational.",
`stopReason: "endTurn"`, provider openai-compatible (gpt-4o), SDK 1.16.0.
Gate item satisfied: adapter boundary, documented credential path, one minimal
invocation — on a long-lived provider, not an expiring free tier.

Notes: `AgentResult` exposes `lastMessage`/`stopReason` (camelCase
`"endTurn"`), not a `result` string; on this path content blocks are plain
`{ text }` objects without a `type` discriminant — relevant to later
structured-output work.

### HACP version-state correction + consumption design (2026-09-03, from the v0.3 scoping session)

- HACP v0.2 protocol documentation exists on public `origin/main`
  (`2410d225…`): `docs/hacp-0.2.md`, CLI-bridge contract, manual-approved-loop
  examples. The `schemas/` index is stale (describes v0.1 only) and schema
  `$id`s remain v0.1-draft — earlier "latest is v0.1-draft" reads were wrong.
  Version state comes from the repo tree, not the schema index.
- who-decides stays on the M1-ruled v0.1 base + extension profile; no
  migration during the hackathon.
- **Consumption design supersedes the field sketch:** a separate immutable
  consumption RECEIPT (not a field written into an approved decision) binding
  the decision + integrity/revision basis + decision request + permitted
  scope + exactly one successor invocation + durable claim identity/time.
  Claim acceptance does NOT prove invocation completion or exactly-once
  external effects.
- Extension mechanics on closed schemas (`additionalProperties: false` at all
  levels): unchanged base decision + separately versioned extension record +
  extension-aware processing REQUIRED for continuation + reject stripped or
  unsupported extension requirements (fail closed against base-only replay).
- Spike test list grows: concurrent claims (two attempts → exactly one
  succeeds), restart survival, claim-before-start failure, ambiguous
  execution, expiry/revocation ordering. Timestamp + idempotency key alone
  are insufficient.
- Demo artifact set grows to five: task-packet, review-finding,
  human-decision, consumption receipt, agent-report (+ stop-response). The
  console artifact panel and the video beat must count five, not four.
- Upstream direction (not ours to land): HACP v0.3-draft = accountable
  continuation + evidence; authority-origin wording fix (humans originate
  authority, packets record it); fixtures to #9; inventory/migration to #11.
  Merge gated on this spike's concurrency/restart evidence (spec follows
  proof). Dual review at ship time means two different tools, not two passes
  from one.

## Day 2 — 2026-09-03 evening: interrupt spike results (M1 evidence)

Three tests, `src/spike-interrupt.ts`, receipts printed per phase.

- **t1 (in-process) PASSED:** tool raised `context.interrupt({name, reason})`;
  agent halted; resume via `new InterruptResponseContent({interruptId, response})`
  delivered the human decision INTO the tool; run completed `endTurn`.
- **t2 (cross-process) PASSED — the M1 bar:** process A ran to interrupt,
  `takeSnapshot({preset:'session'})` → disk → exit. Fresh process B:
  `loadSnapshot(json)` + resume → completed; the tool received the decision.
  Snapshot shape: `data.interrupts.interrupts` (state object nests the map),
  plus `data.messages`, `data.state`, `data.modelState`. The state includes
  `pendingToolExecution` ("resume tool execution without re-calling the model").
- **t3 (replay) — mechanics pass, security FAILS by design:** restoring the
  SAME snapshot and replaying the SAME response produced a SECOND complete
  authorized run. The SDK has NO consume-once semantics. Exactly as the M2
  exchange predicted: an idempotency key / snapshot replay does not prevent one
  decision authorizing two executions. The consumption receipt is load-bearing
  for BOTH resume shapes.

**Headline conclusion — the M1 dichotomy dissolves.** The SDK implements
"mid-run pause" AS a terminated invocation carrying durable pending state,
restored by a fresh process. "Pause" and "terminal + seeded resume" are the
same mechanics with different presentation. RULING M1's conditional ("unless
Strands ships a checkpoint primitive") has technically fired — and it changes
nothing: the ruled design IS the SDK's shape.

**Recommendation to the owner:** keep RULING M1 unchanged; implement the
seeded resume as snapshot + `InterruptResponseContent` (already proven by t2);
the consumption receipt gates replay regardless of shape (proven by t3).

## Day 2b — 2026-09-03: Bedrock commit-or-pivot gate (RULING M4)

Pinned: `global.anthropic.claude-sonnet-4-6`, us-east-1, credentials via
`AWS_PROFILE=who-decides` (IAM user, AmazonBedrockFullAccess dev scope).

| # | Gate item | Result |
|---|---|---|
| 1 | Documented-path auth | ✅ STS preflight + SDK invoke via profile |
| 2 | Tool/interrupt reliability on Bedrock | ✅ t1 interrupt+resume clean |
| 3 | Full M1 loop cross-process on Bedrock | ✅ save → fresh process → resume → endTurn |
| 4 | AgentCore deployability | ⏭️ SKIP WITH DISCLOSURE — not evaluated today; per ruling, AgentCore is stretch-if-ahead and the disclosed fallback is server-side runtime calling Bedrock |
| 5 | Five consecutive seeded runs | ✅ 5/5 identical authority semantics, 6–9s each |
| 6 | Measured cost vs ceiling | ✅ 7,206 in / 2,152 out tokens = **$0.054** est. (rates $3/$15 per MTok) vs $5 ceiling |
| 7 | Adapter isolation | ✅ both providers through one boundary (OpenAI-compatible proven earlier) |

**Verdict: COMMIT — Bedrock confirmed as the documented default.** No pivot;
default + video + live demo stay on Bedrock ("one technically true story").
AgentCore remains a disclosed stretch, never load-bearing.

Runner: `src/gate-bedrock.ts` (`npm run gate:bedrock`); receipts in stdout.
The gate harness itself was designed, run, and recorded by the GLM flash-tier
session — the gate cost $0.054 on Bedrock.

## Day 3 — 2026-09-03 (bank-run block): typed artifact spine

Model-free deterministic build:

- **Schemas vendored:** five HACP v0.1-draft artifact families under
  `schemas/hacp/v0.1-draft/` (Apache-2.0, attributed, upstream $ids intact).
- **Artifact pipeline** (`src/artifacts/`): ajv 2020-12 validation against the
  real schemas + builders modeled on upstream canonical examples.
- **Fixture scenario** (`fixtures/patch-scenario.json`): kestrel-web security
  patch with the seeded runtime-floor tradeoff (node 18→20, one compat check
  unresolved, who-is-affected stated in human terms).
- **Scenario runner** (`npm run scenario`): packet → findings (incl. the
  S2 needs_human_decision tradeoff) → typed stop (HUMAN_DECISION_REQUIRED) →
  scripted human decision → ATOMIC consumption claim → live duplicate-claim
  fail-closed check → dry-run effect receipt (exact payload, no external
  mutation) → agent report correlating decision→outcome. All five artifact
  families validate; run receipt printed; artifacts written to
  `.tmp/scenario-run/`.
- **Tests 7/7** (`npm run test:artifacts`): upstream examples validate; our
  artifacts validate; tampered artifacts FAIL — escalated authority, demoted
  actor (`ai_agent` on a human_decision), missing rationale, reliability
  boundary on a non-reliability stop, and a report claiming
  boundaries-preserved-while-crossing all rejected by the schemas.

Notable vocabulary alignments: HACP decision enum has no `create_draft_pr` —
the human gate is `start_work` (needs_human_decision → approved); the branch
choice lives in our extension layer (rationale + permittedAction on the
consumption record). `reliability_boundary` is forbidden except on
RELIABILITY_LIMIT_REACHED stops.

Remaining: console (M3) wired to this spine, one real-model end-to-end pass
(Bedrock, cents), final video.

(Prerequisites section retired: the Bedrock gate ran and COMMITted — see Day 2b.)

## Day 3b — 2026-09-03: console (M3) + first PR review loop

Console built on `feat/console` (PR #1): SQLite-backed engine, four API routes,
client UI that never preselects and polls only while transitioning. Full loop
green over HTTP; screenshots captured.

PR #1 review loop (Qodo + Codex bot reviews, Joe's dispatch): 11 findings
triaged, 8 patched in the PR. The two that matter most:

1. **Non-approval branches executed the approval branch.** `send_back` and
   `defer` still built the draft-PR payload and an approval-shaped report —
   contradicting the demo's core promise. Fixed: per-branch effect payloads and
   reports; only `create_draft_pr` produces PR fields. Verified over HTTP for
   all three choices.
2. **The human-decision artifact was built from fixture values, not the
   submitted decision.** Fixed: runtime choice/rationale/decision-id flow into
   the artifact; artifact, consumption receipt, and agent report now share one
   decision identity.

Also fixed: idempotency key honored (retry of a committed decision returns
success + `duplicate`), crash between claim and state-write now recovers with
the same successor instead of a competing claim, one-active-run enforced in an
`BEGIN IMMEDIATE` transaction, both receipt kinds structurally validated before
getting a green check, reset archives instead of deleting audit records, and
UI busy states clear on network failure. New suite `npm run test:console`
(6/6). Console auth deliberately deferred → issue #2 (README documents the
boundary).

### HACP v0.3 vocabulary inputs (from real use in this demo)

- No `send_back`/`defer` decision primitives: mapped to `request_review`→draft
  and `cancel_session`→canceled. Both feel like protocol lies of necessity.
- No "unauthenticated/local console" actor-verification source; demo artifacts
  fall back to free-text markers (`demo-unauthenticated-local-console`).
- `agent-report.files_changed` minItems 1 forces reporting preparation as
  changes even when the branch executes nothing externally.

## Day 4 — 2026-09-03: live end-to-end pass (real model on the spine)

`npm run live-loop` (WD_PROVIDER=bedrock, AWS_PROFILE=who-decides,
global.anthropic.claude-sonnet-4-6, us-east-1): one full pass with a real
Strands agent wired to the typed artifact spine.

What the model actually did:

- **Invocation A** prepared the patch summary, called `request_release_decision`
  exactly once, and stopped (`stopReason=interrupt`, 1 interrupt) — no PR, no
  external effect.
- **Invocation B** resumed via `InterruptResponseContent` with the scripted
  human choice (`create_draft_pr` + rationale); the SDK completed the pending
  tool execution and the model ended its turn stating it would take no further
  autonomous action (`stopReason=endTurn`).
- **Spine:** packet + 2 findings + stop-response + human-decision +
  consumption-receipt + effect-receipt + agent-report all built from runtime
  truth and validated against HACP v0.1-draft. Claim atomic; live duplicate
  probe REJECTED (competing_successor). Dry-run only.
- Runtime: 5.6s wall clock for both invocations. Cost well under the $5 gate
  ceiling (single-pass, in line with Day 2b's $0.054/run measurement).

Artifacts in `.tmp/live-run/` (gitignored); summary JSON records provider,
invocation ids, receipt id, and probe outcome. Remaining for the demo: final
video beat using this pass, gallery screenshots from the console, Devpost
Built With tags.

### Day 4 addendum — review-loop hardening (verified live)

PR #4 bot review (Qodo 4 + Codex 3, overlapping): the significant one was
ordering — the live script resumed the agent BEFORE claiming the decision, so
the claim did not gate execution. Restructured to claim-first (matching the
console): a rejected claim stops the run typed; `replayed` is the crash
recovery path. Also: strict interrupt verification against the fixture (name,
question, options, model-provided patchId), choice validated before any model
call, per-branch rationales, claim DB moved outside the artifact dir so
claims survive reruns, and live reports state the simulated workspace in the
artifact itself.

Live verification (2026-09-04, Bedrock):

- fresh tag `verify-claim-first`: claim precedes invocation B; interrupt
  verified as the exact scenario decision request; resume endTurn; duplicate
  probe REJECTED. 6.1s.
- tag reuse: typed stop `DECISION_ALREADY_CLAIMED:competing_successor`;
  invocation B never started; approved branch never executed.
- invalid choice (`ship_it`): `INVALID_CHOICE` before any model call.
