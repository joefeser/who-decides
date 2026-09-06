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

### Day 4 addendum 2 — durable crash recovery, proven live

Codex round 3 (on 693a8bb) caught the live script's unreachable recovery
path: the successor id existed only in memory, so a crash after the claim
made every rerun a competing successor. Fix mirrors the console: per-tag
state file + session snapshot persist BEFORE the claim; reruns replay.

Live proof (tag `crash-proof`, Bedrock):

- fresh run: claim → resume → artifacts → state completed (5.1s);
- simulated crash (state rolled back to `claimed`): snapshot restored,
  invocation A NOT re-run, claim `replayed` with the SAME receipt and
  successor, resume completed (2.0s);
- rerun after completion: typed stop `RUN_ALREADY_COMPLETED`, no model call.

Also: `WD_LIVE_RATIONALE="  "` now fails fast (`RATIONALE_REQUIRED`) before
any model call or claim, matching the schema's nonempty `reason`.

### Day 4 addendum 3 — execution lease: a replayed receipt is not permission

Codex round 4 (P1, correct): persisting the successor identity made a
CONCURRENT same-tag process possible — both would reuse the snapshot and
invocationB, the claim returns `replayed` to the second, and both could run
invocation B (spike t3 proved snapshot replay produces a second completed
run). The claim binds decision→successor; nothing gated EXECUTION.

Fix: per-tag execution lease, created atomically (openSync 'wx'), taken over
only when the recorded holder pid is provably dead (single-machine demo
semantics, documented). Live proof (tag `lease-proof`):

- fresh run: claim → lease acquired → resume → complete;
- crash recovery with dead holder: lease taken over, claim `replayed`, same
  receipt, invocation A not re-run (2.0s);
- forged LIVE holder: typed stop `EXECUTION_LEASE_HELD`, invocation B never
  ran, no model call after the replayed claim.

Residual, named: a holder that dies mid-invocation-B can be taken over and
B re-executed; effects stay dry-run so no external double-effect is possible
in this demo. A transactional effect log would be the real fix (post-demo).

### PR #4 ownership repair — no automatic takeover (2026-09-04)

This supersedes the preceding crash-recovery/lease-takeover claims. A dead PID
cannot show whether invocation B ran. The live-loop now reserves the tag with
exclusive creation before any state, snapshot or artifact writes, and retains
that reservation permanently. Existing reservations, incomplete historical
state, orphan snapshots and replayed claims stop for human inspection. No PID
liveness check, takeover, automatic snapshot replay, or automatic reexecution
remains. Completed runs are read back without mutation. Losing first-time
processes cannot overwrite the winner's state or summary.

Six synthetic integration tests cover empty/blank rationale before runtime
construction, all three choices and completed restart, a process exiting after B
starts, incomplete state with a missing snapshot, empty/dead-holder reservations,
and competing first-time processes. They inject an in-memory fake agent and run
without provider credentials or calls. Existing real-model receipts are not
reused as validation of this change. Authenticated issuer, serialized status and
revocation checks, and safe automatic recovery remain deferred. This stop-only
repair does not adopt those policies or prove provider exactly-once effects.

### Day 4 addendum 4 — takeback: honest report fields and model-as-provenance

Handoff note: from 512e41e/062f634 the live loop uses permanent per-tag
reservation (no takeover; holder death does not authorize reexecution) and
stops HUMAN_DECISION_REQUIRED on any ambiguous state — stricter than the
lease-takeover design it replaced, and kept.

Two findings from the 04:22 review, patched:

- simulated reports now emit `surfaces_changed` (the surfaces the simulated
  preparation targeted) and never `files_changed` — structured consumers no
  longer see edits that never occurred;
- the effect payload records the model as `generatedByModel` (execution
  provenance); `authorizedBy` carries only decision id, receipt, and
  successor — the human decision authorizes, the model executes.

Live proof (tag `takeback-proof`): report has surfaces_changed and no
files_changed; payload has generatedByModel; duplicate probe rejected;
rerun stops typed RUN_ALREADY_COMPLETED. All suites green (live-loop 6,
console 7, artifacts 8, consumption 12, proof 5/5).

## Day 5 — 2026-09-04: lane on main, main is the story

PR #4 (live end-to-end pass) merged at 0d22637 and PR #5 (ACK lane proposal)
at b9b2e57 — both merge commits, per the standing rule. Main now carries the
complete loop: real-model interrupt/resume, typed spine, consume-once claims
with the domain-separated digest, durable no-takeover reservations, execution
leases superseded by fail-closed tag reservation, and the committed (draft)
ACK lane. `agent-control onboard doctor --base main` reports
`onboarding_doctor_ready` against the committed lane; activation (flipping
`status: draft`) remains an explicit owner decision.

Loop retrospective worth keeping: the review loops on PR #4 ran eleven
rounds. Two of my "clean" verdicts were wrong — a hand-rolled timestamp
filter hid live findings twice, and the second false-clean is what prompted
the other Codex session's (correct) takeover. Corrections: last-N unfiltered
reads, thread-level review, and the ACK lane for review state instead of
hand-rolled polling. The miss cost hours; the fix is process, not memory.

Devpost polish begins: gallery screenshots recaptured from merged main
(.tmp/devpost/), README quickstart added.

## Day 6 — 2026-09-05: AgentCore resource pass (pre-gate)

Hackathon resources page surveyed. Relevant finding: the official "Deploy a
Strands Agent to AgentCore Runtime" starter exists, and the judging criterion
explicitly names AgentCore deployment alongside live demos. This upgrades the
9/11 deploy option from raw EC2 to AgentCore Runtime hosting the live-loop
agent. Participant count at survey: 7,709.

AgentCore Runtime facts that shape the demo design (from AWS docs):

- Serverless microVM per session; session ends → microVM terminated and
  memory sanitized. Persistent filesystem across stop/resume cycles is
  supported; Instances (multi-day EC2-backed sessions) also exist.
- Outbound auth flows (API keys/OAuth) are first-class via AgentCore
  Identity; inbound auth integrates Cognito/IdPs.
- Up to 8h microVM sessions; consumption-priced.

Architecture note (the M1 payoff): AgentCore's session model — terminate on
stop, resume as a new invocation seeded with prior state — is EXACTLY the
M1 ruling shape (terminal typed stop + seeded resume, never pause-and-hold).
The ruling made in the governed debate turns out to be the serverless-native
one. Chosen model if we deploy: microVM (terminate on stop), NOT Instances
(multi-day hold would tempt the pause semantics we rejected on purpose).

DB interaction stance: the agent never holds write authority over decision
records. Agent → authenticated decision API (AgentCore Identity outbound) →
authority service owns the store (Postgres via the PR #7 seam). The agent
may keep only its own session/snapshot state on the runtime's persistent
filesystem. Direct agent→DB is technically possible and architecturally
wrong for this contract.

## Day 6 addendum — PR #9 merged: the evidence-integrity proof (v0.3 gate closed)

PR #9 (receipt-bound proof inventory) merged at 9a216e9 after the full
three-family convergence: Codex built it (receipts emitted by test bodies,
inventory derived from receipts), GLM took over and fixed three
receipt-MAPPING P1s (coverage claims bound to tests that genuinely exercise
their fixtures, start-boundary action check regression-pinned, all three
invalid-base variants), Astra final-checked (stop-code propagation on
second-clock failure, fork/truncation history coverage, scheduler-independent
revoke/start race) with zero new P1s. Owner override merge on the gate's
staleness-only objection.

The evidence-integrity species, now closed at three layers: static labels
(PR #8), receipt architecture (PR #9 build), receipt mappings (PR #9 round
2). Proof stands at 43/44 with legacy migration explicitly unclaimed —
the one architecture decision remaining for HACP v0.3. 79 tests green on
main; both proofs passing.

### Day 6 addendum — same-file legacy admission candidate

The two-review architecture gate chose a narrow same-file-only support rule,
not a shared registry. Candidate startup now requires one owner-bootstrapped,
identity-pinned SQLite main database and a closed inventory of all enabled
legacy writers. Path strings alone are rejected: canonical path, opened-main
device/inode, persistent database ID, filesystem type, configuration
generation, default local VFS posture, and WAL/FULL/NORMAL settings must remain
the admitted values. Guard placement and its physical directory identity are
also manifest-bound and revalidated during acquisition. Missing, separate,
aliased, replaced, unknown, stale, or
unapproved stores/writers fail closed before candidate mutation.

The proof's final fixture uses independent processes and connections to force
both real `BEGIN IMMEDIATE` winner orderings. Legacy-first leaves one immutable
receipt and no candidate slot; candidate-first leaves one candidate slot and
returns `profile_slot_conflict` to legacy with no receipt. Both processes close
before independent reopen, exact byte/digest checks, union-count-one, and
`PRAGMA integrity_check`. The receipt-bound inventory is 44/44 while preserving
the recurring defect boundary: **EVIDENCE_INTEGRITY — proof observed labels
outran test bodies**. This remains local, closed-world candidate evidence, not
migration, distributed coordination, deployment, release, or owner acceptance.

## Day 6 final — PR #10 merged: same-file admission enforced, 44/44 closed

PR #10 merged at c6677da on an explicit owner override (Joe: "astra review
and patch and merge" — the review-hell ceiling was reached and the owner
closed it). The proof inventory now stands at 44/44 with ZERO uncovered
cases: the last one (legacy-insert-races-profile-admission) went from
uncovered → enforced (same-file constraint pinned with both real BEGIN
IMMEDIATE winner orderings proven across processes).

The final round added two structural defenses: the ANCHOR — a hardlink to
the admitted database inside the pinned guard directory that keeps the
original inode alive, making pristine byte-clone replacement impossible at
the filesystem level (inode numbers of live inodes are never reused), with
anchor-directory ctime pinning detecting anchor rebuilds; and authority
withholding — trusted human acts are not persisted while the configured
writer inventory is incomplete, installing only after the closed-inventory
check (eagerly or lazily inside the first authorized decision).

Review-lineage note for v0.3: this PR's loop (Codex ×N → GLM ×2 → Codex
catching GLM's own test gap → structural fix) is the strongest evidence yet
that the ceiling exists because reviewers keep finding real things. The
owner gate exists exactly for this: convergence is a judgment, and today it
was made by the human. Residual risk named on the record: an adversary who
can recreate the pinned guard-directory identity AND anchor contents has
full local filesystem control — the owner trust boundary itself.

## Day 7 — 2026-09-06: HACP v0.3.0-candidate PUBLISHED

HACP PR #45 merged to main at db47da2 (12:33): the v0.3.0-candidate protocol
packet is live, closing the loop — debate → spike → proof → candidate
standard. Publication label decided by the owner on my recommendation:
CANDIDATE, not release, with three explicit promotion criteria (second
independent implementation; same-file legacy migration exercised in a real
eligible deployment; real-effect semantics separately specified and proven).
who-decides' evidence is pinned in the packet at exact heads and proof SHAs
(e47515f / c6677da, 44/44 receipts). The flywheel's first full turn took
eight months of concept + two days of receipts.
