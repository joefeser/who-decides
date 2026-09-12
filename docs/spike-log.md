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

## Day 7 addendum — AgentCore spike findings (deploy shape decided)

Sub-agent research against AWS docs + the agentcore-samples repo:

- AgentCore Runtime is a per-session, AUTHENTICATED invocation service
  (SigV4/OAuth on every protocol; clients call InvokeAgentRuntime, never
  the agent's port directly). It is NOT a public web host. The intended
  split is exactly ours: agent on AgentCore, public surface on a plain
  HTTPS host.
- microVM per runtimeSessionId; terminate-on-end, memory sanitized;
  idle timeout default 900s; max 8h; /mnt sessionStorage survives
  same-session resume only — durable state lives in OUR store via the
  decision API, never inside the runtime. This is M1's terminal-stop +
  seeded-resume ruling, natively.
- Outbound HTTPS unrestricted by default (networkMode PUBLIC); execution
  roleArn + AgentCore Identity for credentials. Our live-loop agent calls
  the decision-authority API directly — no special config.
- Deploy: new `agentcore` CLI scaffolds Strands Agents ("recommended"),
  deploys CodeZip via CDK. TS path exists (Strands TS + Express, Node 22,
  /ping + /invocations) — sample 07-direct-code-deploy-typescript.
- Pricing: microVM $0.0895/vCPU-hr actual-CPU + $0.00945/GB-hr peak
  memory (128MB floor); idle-open sessions accrue until the 15-min idle
  kill. Our pattern (short invocations, terminate between) is the cheap
  shape.

Deploy architecture (locked): Strands live-loop agent on AgentCore
(HTTP protocol, CodeZip, short sessions) -> decision-authority API on the
HTTPS host (Next.js console, operator-gated) -> Postgres store. The agent
never holds DB credentials; everything crosses the authority boundary.

## Day 7 addendum 2 — PR #13 merged: the public-demo foundation is on main

feat/public-demo merged at 51ec886 (operator auth gate, watch mode, deploy
assets), built by a flash session under the lane with 13 review findings
fixed across three passes (spoof-resistant rate limiting, fail-closed
config, authenticated session attribution threaded into decision artifacts,
passcode-rotation invalidation, split Caddy zones, quickstart env docs).
The evidence-integrity reflex held at the free tier: the artifacts stopped
claiming demo-unauthenticated attribution the moment a real operator
session existed — reviewer-caught, not self-caught, and that is the system
working.

Two honest notes on the record: (1) the packet's "scrypt" wording vs sha256
spec discrepancy was resolved toward the explicit mechanical spec with a
flagged follow-up for a salted slow hash if the hosted demo wants it;
(2) a concurrent-session worktree collision occurred mid-build and was
recovered with a dedicated worktree — the C-block collision hazard is now
demonstrated twice, and dedicated worktrees are henceforth mandatory for
parallel sessions in this repo.

## Day 7 addendum 3 — HACP conformance package landed; qualification ruled

HACP PR #46 merged (122bfde): the executable v0.3-candidate conformance
package — seven closed JSON Schema 2020-12 contracts, reproducible RFC 8785
JCS digest vectors (compute-vectors.mjs, one-command check
hacp:v03-candidate), a seven-record valid chain and 22 negative fixtures
covering the full failure taxonomy WITS's B1 report demanded. Provenance
table honestly maps which shapes derive from who-decides's proven
local-owner contracts. Both REVIEW-REQUIRED items were correctly held for
the owner.

Owner ruling (recorded as HACP issue #47): second-implementation
qualification = Option 1, independent production + cross-validation with
who-decides (no runtime imports). Bidirectional production (Option 2) is
reserved as the future RELEASE gate — logged for later, not lost. WITS
Interworking Proof v0 may proceed under Option 1 semantics. Digest-domain
strings remain REVIEW-REQUIRED (normative; change = contract change).

## Day 7 addendum 4 — PR #15 merged: the Postgres adapters are on main

feat/store-postgres merged at 79968fb after the full three-family
convergence: Codex x2 (8 findings incl. the expired-claim fast-path
replay), owner disposition of the engine-level reset-mid-submit seam gap
(issue #16 — with the SQLite counterpart's missing archived guard noted),
Astra independent pass (9 findings, 1 P1: waiting claimants replaying
after expiry; plus a 260-line review suite pinning its own findings).
Verified 88/88 SQLite + 49/49 Postgres on a fresh disposable cluster.
WD_STORE=sqlite|postgres; local demo byte-identical on the default.

The demo block's construction is complete: A2 architecture (AgentCore
agent/host split), A3 adapter, A4/A5/A6 auth/watch/deploy — all merged,
all three-family reviewed. One operational note: pg is a runtime dep on
main now (fresh clones need npm install before tsc — noted after my own
false alarm).

## Day 7 addendum 5 — HACP #48 resolved: product meaning ≠ continuation authority

HACP PR #49 merged (2f7580f, via dev): the WITS interworking seam is
dispositioned. Product Decisions stay NON-AUTHORIZING (executionAuthorized:
false is honest product state, not a gap); a WITS-native continuation
approval act is the required bridge; the #47 qualification ruling (Option 1,
cross-validation) is recorded. v0.3 schemas and digest domains unchanged.
Corpus 7/29/33, evidence 44/44, regressions 23/23 — all green.

Net: the second-implementation ladder now has every rung in place —
executable conformance package, qualification ruling, and the authority-seam
disposition. WITS's next tranche (the continuation-approval act + projection)
is unblocked with zero open contract questions.

## Day 7 addendum 6 — AC-1 merged; parallel tracks status

AC-1 (agent service, PR #25) merged into dev-agentcore at 4a32d8c after
three review rounds (4 Codex P1/P2 + 7 Qodo H/M + 3 Codex round-3
P1/P2 — full-spine run scoping, persisted-bytes evidence digest, decision
lock, fixture pinning, honest unverified-pending-ac2 channel, sessionId
400s). Unit branch healthy: tsc clean, 92/92.

Parallel: WITS confirmed HACP #48 closed (main at 1b94a3a) and its
origin/dev includes PR #1364; its next step is repinning the interworking
spec to new HACP main, reconciling the #48 disposition, two independent
reviews, then Tasks 1.1–1.6 (the continuation-approval act and projection).
All three repos are moving simultaneously on the same ladder.

## Day 7 addendum 7 — HACP #51 closed (second contract gap surfaced and fixed)

HACP #51 (stop_response vs started-successor contradiction — the second
gap the WITS second implementation surfaced, after #48) closed via PR #53
(50741e30 on main): "Correct v0.3 candidate branch conformance." WITS's
UPSTREAM_CONTRACT_AMBIGUITY stop is lifted; its next step is repinning to
this HACP main and running the digest-verified dual-review round it queued.
The ladder's scorecard: two gaps, both caught at gates, zero improvised
work, both resolved upstream by the standard's owners.

## Day 8 — 2026-09-07: AC-3 and AC-4 merged — the unit's build is done

AC-3 (host proxy, PR #27, 7815334) merged after four review rounds (14
findings: wrong-run dispatch race, both stream shapes, the SDK package
name 404 caught by CI, and the final pair — dispatch the AUTHORITATIVE
STORED decision on every submit with duplicate-retry recovery). AC-4
(agentcore scaffold, PR #28, 8368309) merged merge-ready-strict: the
flash session read the actual zod schemas inside @aws/agentcore@0.28.1
and corrected the packet twice (protocol not serverProtocol, entrypoint
not entryPoint, no build command — validate is the local gate). agentcore
validate returns Valid.

The flash session's four AC-5 prerequisites (each with doc citations,
deferred by disposition — src/ is frozen for AC-4):
1. /ping returns {ok,...} not the documented {"status":"Healthy"} — align
   before first deploy.
2. CodeZip/esbuild will likely fail on better-sqlite3's native addon —
   externals, restructure, or Container build.
3. server.ts reads fixtures/patch-scenario.json from CWD at import — won't
   exist in the zip.
4. Replace the placeholder account ID (000000000000).

Unit state: dev-agentcore has AC-1 through AC-4. Remaining: AC-5 (Joe:
IAM + first deploy, now with the four named prerequisites), AC-6 (gated
live test + PROVISION half), then the one final PR to main.

## Day 8 addendum — WITS architecture gate merged; critical path now HACP #54

WITS PR #1365 (the interworking spec, post-#48/#51 repin and dual review)
merged to WITS dev at 20ed2b2. The architecture gate is complete; runtime
implementation (Tasks 1.0–1.7) is explicitly HELD pending:
1. HACP #54 publishes the external/supplementary bundle admission schema
   (the cross-validation entry point for a second implementation's fixtures)
2. WITS repins the package
3. Joe authorizes Tasks 1.0–1.7
4. WITS produces independent fixtures → cross-validated through HACP

This ordering (schema before implementation) avoids building WITS twice
against a changing admission contract — the same spec-follows-proof
discipline that produced the who-decides evidence chain. WITS #1366 tracks
post-candidate production hardening separately.

All three repos' boards are now clean dependencies:
- who-decides: AC-5 (Joe) → AC-6 → final unit PR
- HACP: #54 (the ladder's current rung) + #52 (no-decision identity, later)
- WITS: waiting on #54, then Joe's authorization

## Day 8 addendum 2 — AGENT DEPLOYED ON AWS (AC-5 deploy complete)

The AgentCore runtime deployed successfully at 2026-09-07T22:12 UTC:
- Runtime: whoDecides_who_decides_agent-1mF5fr45DG
- ARN: arn:aws:bedrock-agentcore:us-east-1:937830454526:runtime/whoDecides_who_decides_agent-1mF5fr45DG
- Stack: AgentCore-whoDecides-who-decides-dev
- Execution role: AgentCore-whoDecides-who--ApplicationAgentWhoDecide-ZOJtpf1P647v

The path there (3 deploy failures, each with a real lesson):
1. CDK project not found — AC-4 scaffolded config but not the CDK infra;
   fixed by generating the cdk/ tree via agentcore create --no-agent.
2. Broken node_modules bin links from the copy — fixed with a clean
   npm install.
3. Entrypoint validation: the AgentCore API rejects .ts entrypoints for
   NODE_22 runtime — compiled main.ts to a bundled main.js via esbuild
   (359KB CJS, native addons external). The CLI validates .ts but the
   API validates .js; the config now names the compiled output.

Remaining for AC-5: attach PowerUserAccess (done), verify the runtime
responds (invoke test), capture the endpoint for the console's
WD_AGENTCORE_ENDPOINT env var.

## Day 8 addendum 3 — state-loss recovery + deploy prerequisites (2026-09-07)

After the successful deploy, `invoke` failed with `State config file not
found`: the post-deploy cleanup commit (763e888) gitignored
`agentcore/.cli/` as "build/cache dirs" and the cleanup deleted
`deployed-state.json` — which is the deployment record, not cache.

Lessons, all verified live:
1. `agentcore deploy` hard-requires `uv` (brew install uv); the dependency
   check is unconditional on @aws/agentcore 0.28.1, no skip flag.
2. Recovery for lost state is a plain re-run of `npx agentcore deploy`:
   CDK adopted the existing runtime in place (runtime ID
   whoDecides_who_decides_agent-1mF5fr45DG unchanged) and rewrote the
   state file.
3. `agentcore import runtime` is NOT a recovery path here — it refuses
   because `agentcore.json` already declares `who_decides_agent`, and
   add/remove have no runtime subcommand. Raw `cdk deploy` updates AWS
   but never writes the state file.
4. `agentcore status --runtime-id <id>` works without local state and is
   the fastest way to confirm a runtime is live.

DEPLOY-CHECKLIST.md restructured around these (prerequisites, deploy
sequence, recovery, resolved blockers). aws-targets.json
REPLACE_BEFORE_DEPLOY warning retired — account verified live.

## Day 8 addendum 4 — first invoke: two boot crashes behind "deploy complete"

The first real invoke (22:36 UTC) returned "Runtime initialization time
exceeded" — AgentCore's 30s init window expired because the Node process
crashed before binding 8080. CloudWatch logs showed the true error; the
init-timeout message alone hides it. Lesson: read runtime logs on any
invoke failure before touching config.

Crash 1 (FIXED): `src/artifacts/schemas.ts` read the seven vendored HACP
schema JSONs via cwd-relative `readFileSync` at module load. The CodeZip
ships only the esbuild bundle — no payload files — so under `/var/task`
boot hit ENOENT. Fix: static JSON imports (esbuild inlines them), the same
pattern `agent-service/fixture.ts` already used for patch-scenario.json.
Verified: tsc clean; test:artifacts 8/8, test:agent-service 5/5,
test:local-owner 46/46.

Crash 2 (OPEN, decision needed; resolved the same evening by the container
repair — see Day 9): the boot graph imports better-sqlite3 at
module load (`agent-core/phases.ts:25` → `consumption/store.ts:14`,
`store-admission.ts` same chain). The native addon cannot ship in a
CodeZip and the CLI has no externals field — this was checklist blocker
"better-sqlite3 cannot ship in a CodeZip", never actually resolved; the
17:12 "deploy complete" proved packaging only. Remedies for Joe:
(a) Container build — the original fallback, no governed-code changes;
(b) port the claim store to node:sqlite (available unflagged on the
runtime's Node 22.23) — stays CodeZip but swaps the engine under the
hardened admission contract, so it warrants dual review.

Also open: the runtime env carries no `WD_MACHINE_TOKEN_HASH`, so once the
runtime boots, invocations still fail closed with 503 MACHINE_AUTH_DISABLED
until the secret-injection mechanism is chosen (`.env.local.example`:
never in git). The start-of-session dev token's sha256 is the intended
value once a mechanism exists.

## Day 9 — 2026-09-08: Codex container repair (AC-5 repackage) + stash recovery

Joe chose the container path. Codex's repair commit 8056d0b repackaged the
agent as a Node 22 linux/arm64 container (agentcore/Dockerfile) with
better-sqlite3's native addon inside the image — Crash 2 above is resolved
by that choice, not by a node:sqlite port. The same commit fixed live
dispatch/decision binding (runs resume only their own confirmed decision),
the `app/api/*` live-mode routes, and added regression coverage including
`src/server/live-dispatch.test.ts`.

Local gates passed after the repair: 122 unit tests, 50 Postgres tests,
tsc, next build, `agentcore validate`, and an ARM64 container smoke that
boots the image and loads native SQLite. These prove the artifact, not the
deployment: AC-6 still needs the repaired image deployed, the runtime env
carrying `WD_MACHINE_TOKEN_HASH`, and a real A→human decision→B cycle.

Stash recovery: this session's IDE rebase autostash (recovered as
e1ca26ed after deletion) held addenda 3 and 4 above plus schema-JSON
imports, the live account ID, and a checklist restructure. The schema and
account changes were already incorporated by 8056d0b verbatim; the
checklist restructure was superseded by 8056d0b's rewrite (which keeps the
uv prerequisite, the `.cli/` state warning, and the honest
"READY ≠ working invocation" gate). Only the two addenda were missing and
are restored above, with Crash 2's status annotated.

## Day 9 addendum — deployed runtime verified still broken (2026-09-08)

With the AWS session restored, the live prerequisites were verified
read-only against the control plane and CloudWatch:

- Runtime `whoDecides_who_decides_agent-1mF5fr45DG` is READY, but its
  artifact is still the pre-repair CodeZip: S3 CDK asset
  `cd2ccbcf…zip` (hash-identical to the local pre-repair
  `agentcore/cdk/cdk.out` asset), entryPoint `main.js`,
  `lastUpdatedAt 2026-09-07T22:13:36Z` — before the repair commit
  (2026-09-08T02:23Z). The repaired container is NOT deployed.
- The newest CloudWatch boot attempt still crashes with addendum 4's
  Crash 1 verbatim: `ENOENT /var/task/schemas/hacp/v0.1-draft/
  task-packet.schema.json` under `/var/task`. Any invoke today burns
  the 30s init window; READY is proof of nothing.
- Runtime `environmentVariables` carry only WD_AGENT_DATA_DIR,
  WD_AGENT_PORT, WD_PROVIDER — no `WD_MACHINE_TOKEN_HASH`, so even a
  healthy boot would fail every invocation closed with
  `MACHINE_AUTH_DISABLED`.
- The account session (root-equivalent) covers the manual gate's AWS
  permissions. The EC2 console host's env (`WD_AGENTCORE_ENDPOINT`,
  `WD_MACHINE_TOKEN`) is not verifiable from a laptop and remains
  Joe's on-host check.

Blockers to a real AC-6 cycle, in order: (1) owner decision on the
`WD_MACHINE_TOKEN_HASH` injection mechanism, (2) authorized redeploy of
the repaired container (`deploy --dry-run` diff review first), (3) console
host env config, (4) `npm run test:agentcore-live` from a credentialed
host.

## Day 9 addendum 2 — synth recursion found and fixed; dry-run clean (2026-09-08)

Joe decided blocker (1): the hash is installed **post-deploy** via
`aws bedrock-agentcore-control update-agent-runtime --environment-variables`
(no secret in tracked config; must be re-applied after every deploy
because a tracked-config deploy drops it — checklist step 3 records this).

Then the authorized `deploy --dry-run` failed: CDK synth died with
ENAMETOOLONG. Root cause: the container source asset stages the repo-root
build context into `cdk.out/asset.<hash>`, and `ContainerSourceAsset`
appends force-keep patterns for the Dockerfile's ancestor directories
AFTER the user `.dockerignore` — with `agentcore/Dockerfile`, the
`!agentcore` ancestor negation re-included the `agentcore` subtree in
CDK's DOCKER ignore matcher, so the staging swept `agentcore/cdk/cdk.out`
into itself and nested until paths overflowed (one synth run went 8+ deep;
the old cdk.out had accumulated 9 levels / 2.3 GB). Fix: move the
Dockerfile to the context root (`agentcore.json` `dockerfile: "Dockerfile"`),
so force-keep emits only `!Dockerfile` and the `agentcore/cdk` exclusion
holds. After the move: clean cdk.out, `agentcore validate` Valid, dry-run
and `--diff` both green.

Diff review (read-only): the CodeZip → Container move updates
`AWS::BedrockAgentCore::Runtime` IN PLACE (`CodeConfiguration` →
`ContainerConfiguration`, runtime ID unchanged, no replacement); all else
is additive (ECR repo + KMS key, CodeBuild project, Lambda build trigger,
ECR-pull/KMS-decrypt grants). Real deploy awaits Joe's authorization.

## Day 9 addendum 3 — first container deploy failed + the replace fix (2026-09-08)

Joe ran the real deploy (deploy-20260908-143109): 5m13s, FAILED, clean
rollback (UPDATE_ROLLBACK_COMPLETE; the freshly created ECR/KMS/CodeBuild/
IAM resources deleted; the old runtime untouched). The handler error:

    Resource handler returned message: "Invalid request provided: Agent
    artifact type cannot be updated" (HandlerErrorCode: InvalidRequest)

on AWS::BedrockAgentCore::Runtime. Lesson, now proven by the service: the
CDK `--diff` "[~] in-place update" was a fiction at the API level — the
AgentCore control plane forbids changing an existing runtime's artifact
type entirely. The runtime resource must be REPLACED.

Fix in the vendored stack (agentcore/cdk/lib/cdk-stack.ts): after
constructing AgentCoreApplication, every `aws_bedrockagentcore.CfnRuntime`
gets `overrideLogicalId('AgentRuntimeContainer<index>')` — CloudFormation
then creates the container runtime fresh and deletes the CodeZip one in a
single deploy. Accepted consequence: the runtime ID and ARN change;
WD_AGENTCORE_ENDPOINT must be updated wherever configured, and the
checklist's hash-patch step no longer hardcodes an ID.

Side effects of the failed attempt worth keeping: the CloudWatch log group
`...-1mF5fr45DG-DEFAULT` survives with the boot-crash history; the runtime
itself is unchanged (still READY, still the broken CodeZip), so a READY
status still proves nothing; the console-side live-dispatch config was
never set, so nothing downstream referenced the old runtime except this
repo's docs.


## Day 10 — 2026-09-09: AC-6 GATE GREEN — the live cycle is proven (6/6)

The full path, with each deploy lesson in its place:

1. PR #32 merged (63da7cd): typed rejections ride as HTTP 200 + ok:false.
   The platform DROPS non-2xx bodies — gate round 1 falsified the
   dispatcher's "platform delivers typed 409s" assumption (3 gate tests
   failed on `no invocation envelope (Received error (409))` while every
   200 path delivered full envelopes). The dispatcher also now surfaces
   the envelope's typed status/reason instead of a generic
   AGENT_REJECTED placeholder.
2. Redeploy attempt 1 failed in CodeBuild: `node:22-bookworm-slim: 429
   Too Many Requests` from Docker Hub — anonymous pull limits are per-IP,
   and CodeBuild's shared IPs exhaust them intermittently (same
   Dockerfile built fine the day before). PR #33 (2f469bc): base image
   from public.ecr.aws; local ARM64 build + container smoke green.
3. Redeploy 2: SUCCESS in ~3.5 min. Runtime
   `whoDecides_who_decides_agent_container-dtvXkDG2Ps` READY, container
   artifact (ECR image), version 4 → hash re-applied per checklist step
   3 → version 5, hash-match verified. The deploy re-applies tracked env
   vars WITHOUT the patched hash — the documented caveat, now observed
   live twice. AWS login grants also kept expiring (~hourly); purely
   operational.
4. GATE (`npm run test:agentcore-live`, token sourced from a local
   0600 file, never in chat/commands): **6/6 pass, 0 skipped, 26.8s**:
   - phase A DECISION_REQUIRED (17.2s — cold container boot, clean)
   - phase B COMPLETED with bound decision/invocation/receipt evidence
     (2.2s; successor ≠ invocation A; effect authorizedBy joins all three)
   - identical resume → DUPLICATE, same receipt, no new successor
   - different choice → STATE_CONFLICT; rationale-only → STATE_CONFLICT;
     original receipt unchanged after both
   - rejection discipline on a fresh run: INVALID_CHOICE and
     RATIONALE_REQUIRED are typed, consume nothing, and the run still
     completes
   - the main lifecycle runs through ConsoleEngine with real SQLite
     stores: running → decision_required → completed, artifacts valid,
     displayed effect cross-bound to the runtime effect, displayed
     resume evidence from this run's live session

Deployed revision: merged dev-agentcore 2f469bc (Dockerfile ECR Public
base) as image `whodecides/who_decides_agent:3bac0f0b…`; runtime ID/ARN
changed from the retired CodeZip runtime exactly as the control plane's
artifact-type immutability forced.

Honest residuals: the browser-level hosted console UI was not exercised —
the gate drives ConsoleEngine (the same engine `app/api/*` uses) with
real stores on this host; the public EC2 host remains unconfigured.
Machine-auth 401/503 bodies are dropped by the platform too, so auth
failures surface as opaque transport errors (fail-closed; acceptable for
a failure path). The gate passing is AC-6 engine evidence; closing the
board item remains the owner's call.

## Day 8 addendum 3 — state-loss recovery + deploy prerequisites (2026-09-07)

After the successful deploy, `invoke` failed with `State config file not
found`: the post-deploy cleanup commit (763e888) gitignored
`agentcore/.cli/` as "build/cache dirs" and the cleanup deleted
`deployed-state.json` — which is the deployment record, not cache.

Lessons, all verified live:
1. `agentcore deploy` hard-requires `uv` (brew install uv); the dependency
   check is unconditional on @aws/agentcore 0.28.1, no skip flag.
2. Recovery for lost state is a plain re-run of `npx agentcore deploy`:
   CDK adopted the existing runtime in place (runtime ID
   whoDecides_who_decides_agent-1mF5fr45DG unchanged) and rewrote the
   state file.
3. `agentcore import runtime` is NOT a recovery path here — it refuses
   because `agentcore.json` already declares `who_decides_agent`, and
   add/remove have no runtime subcommand. Raw `cdk deploy` updates AWS
   but never writes the state file.
4. `agentcore status --runtime-id <id>` works without local state and is
   the fastest way to confirm a runtime is live.

DEPLOY-CHECKLIST.md restructured around these (prerequisites, deploy
sequence, recovery, resolved blockers). aws-targets.json
REPLACE_BEFORE_DEPLOY warning retired — account verified live.

## Day 8 addendum 4 — first invoke: two boot crashes behind "deploy complete"

The first real invoke (22:36 UTC) returned "Runtime initialization time
exceeded" — AgentCore's 30s init window expired because the Node process
crashed before binding 8080. CloudWatch logs showed the true error; the
init-timeout message alone hides it. Lesson: read runtime logs on any
invoke failure before touching config.

Crash 1 (FIXED): `src/artifacts/schemas.ts` read the seven vendored HACP
schema JSONs via cwd-relative `readFileSync` at module load. The CodeZip
ships only the esbuild bundle — no payload files — so under `/var/task`
boot hit ENOENT. Fix: static JSON imports (esbuild inlines them), the same
pattern `agent-service/fixture.ts` already used for patch-scenario.json.
Verified: tsc clean; test:artifacts 8/8, test:agent-service 5/5,
test:local-owner 46/46.

Crash 2 (OPEN, decision needed): the boot graph imports better-sqlite3 at
module load (`agent-core/phases.ts:25` → `consumption/store.ts:14`,
`store-admission.ts` same chain). The native addon cannot ship in a
CodeZip and the CLI has no externals field — this was checklist blocker
"better-sqlite3 cannot ship in a CodeZip", never actually resolved; the
17:12 "deploy complete" proved packaging only. Remedies for Joe:
(a) Container build — the original fallback, no governed-code changes;
(b) port the claim store to node:sqlite (available unflagged on the
runtime's Node 22.23) — stays CodeZip but swaps the engine under the
hardened admission contract, so it warrants dual review.

Also open: the runtime env carries no `WD_MACHINE_TOKEN_HASH`, so once the
runtime boots, invocations still fail closed with 503 MACHINE_AUTH_DISABLED
until the secret-injection mechanism is chosen (`.env.local.example`:
never in git). The start-of-session dev token's sha256 is the intended
value once a mechanism exists.

## Day 12 — 2026-09-12: PR #35 review triage — two real wedges patched

Qodo's review of the final unit PR surfaced four findings; triaged against
live code before the owner merge decision (Sourcery skipped: diff over its
300k-char limit):

1. **Stuck `resuming` after remote-confirm (patched — real).** The
   elapsed-time sweep explicitly skips `execution_mode = 'agentcore'`
   (state.ts advancePhases), so a crash or local persistence failure after
   the runtime confirmed the resume — but before local finalize — left the
   run in `resuming` forever: resubmission returned
   `AGENT_RESUME_IN_PROGRESS`, reset threw `DECISION_IN_PROGRESS`, no new
   runs could start. The confirmed `agent-resume` dispatch artifact (stored
   before the effect write) is now repair evidence: the same submission
   falls through, replays the claim, rebuilds the deterministic artifacts,
   and wins the `resuming → completed` CAS — no redispatch, no new
   successor. Mid-demo crash recovery no longer needs DB surgery.
2. **Console-vs-runtime successor IDs (dispositioned — by design).** The
   console's effect receipt cites the console's reserved claim successor;
   the runtime's spine uses its own invocation IDs. Two spines, joined by
   the run tag in the runtime decision ID and the stored dispatch
   envelopes. Unifying them (Qodo's suggested fix) would change the
   service contract mid-unit; documented in README demo boundaries
   instead.
3. **Terminal claim rejection wedge (patched — hard to reach, cheap to
   close).** A rejected claim retained its intent with the run still
   `decision_required`, wedging reset forever. Rejections are now parked
   `blocked` (reset-archivable; intent and dispatch evidence retained).
4. **Concurrent double-start race (dispositioned — cosmetic).** The loser
   of the `running → starting` CAS can see a stale pre-CAS state and get
   an error instead of idempotent success; single-operator demo, retry
   succeeds. Not patched at deadline.

Local gates after the patch: all 9 suites **125/125** (two new regression
tests in live-dispatch: repair-without-redispatch, claim-rejection parks
blocked + reset recovers), `tsc --noEmit` clean.

### Day 12 addendum — Codex round on the patched head: all three valid, patched

Codex reviewed e99e6f2 and found the follow-on gaps in the same area
(2×P1, 1×P2); all three were verified live and patched:

1. **Completion acceptance didn't validate the returned effect (P1).**
   The predicate checked status/decisionId/receiptId/invocationB only, so
   a runtime reporting a foreign effect, a non-dry-run, or mismatched
   authorization references would be accepted and the console would
   synthesize its own local effect over it. The live gate's
   `assertCompleted` predicate (effect === choice, dry-run,
   noExternalMutationPerformed, authorizedBy joins) is now the
   production acceptance rule; violations are typed rejections to
   `blocked`.
2. **No recovery when persisting the confirmation fails (P1).** The
   repair key is the `agent-resume` artifact — if the write itself failed
   (transient outage), the run wedged `resuming` with no artifact. Three
   layers now: bounded retry on the confirmation write; a resuming run
   with NO artifact is resettable (store-level rule, SQLite + Postgres);
   and an in-memory in-flight registry keeps genuinely in-flight resumes
   reset-proof (the pre-existing concurrency test caught the first
   relaxation attempt over-reaching — reset during a held dispatch must
   still throw).
3. **Phase-A acceptance not bound to the run (P2).** Fixture matching
   alone would open the human gate for a stale/malformed response;
   `decisionId === decision-svc-<run>` and non-empty `invocationA` are
   now required in the production predicate (the live gate already
   asserted both).

Gates: all 9 suites **129/129** (four new live-dispatch regression
tests), `tsc --noEmit` clean.
