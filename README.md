# Who Decides?

A [Strands Agents](https://strandsagents.com/) agent that works in the background
and surfaces **only when there's a real human decision** — then stops, waits, and
resumes to do exactly what was approved. Nothing more.

Most agent demos optimize for autonomy: let it run, let it act, review the
aftermath. This project inverts that. The agent runs a bounded job, gathers
evidence, and when it reaches a decision that belongs to a human, it emits a
**typed decision request** and halts. A human approves or rejects. The agent
resumes from its persisted session, executes only the approved action, and
returns a report that ties the outcome back to the decision that authorized it.

## The loop

1. Receive a bounded job (task packet with explicit authority).
2. Collect evidence and prepare a proposed action.
3. Emit a typed human decision request — question, options, evidence, consequences.
4. **Stop.** No execution before approval, no "ask forgiveness" path.
5. Resume from the same persisted run after the human approves or rejects.
6. Execute only the approved action.
7. Produce a typed report connecting the decision to the outcome.

The decision request is not a confirmation dialog. It is a structured artifact:
what the agent wanted to do, why, what evidence supported it, what it was
forbidden from doing, and what would have happened on the other branch. Every
stop has a reason. Every resume references the decision that unlocked it.

## Why "Who Decides?"

Because that's the only question that matters when an agent surfaces from the
background. Not "what did it do?" — you can read a log for that. The interesting
moment in any agentic system is the transfer of judgment: when does the machine
decide, and when does the human? This project takes a hard line: authority is
explicit, declared up front in the task packet, and never silently transferred.

## Status

Being built for the [Agents for Humans](https://agentsforhumans.devpost.com/)
hackathon (AWS / Strands Agents SDK), September 2026. The core loop is proven:
a real Strands agent on Bedrock stops at a typed decision request, resumes on
a recorded human decision, and every artifact validates against the vendored
HACP schemas. See [docs/roadmap.md](docs/roadmap.md) and
[docs/spike-log.md](docs/spike-log.md) for evidence. The full build epic —
every milestone from the governed design debate through the AgentCore
deployment — is on the public
[who-decides project board](https://github.com/users/joefeser/projects/1).

**Live demo:** <https://who-decides.88mphserver.com> — public watch mode is
read-only; sign in as the operator (passcode in the hackathon submission)
to run the demo end to end. Deployed per [deploy/PROVISION.md](deploy/PROVISION.md).

## Quickstart

```sh
nvm use   # Node 22, matching CI and the runtime image
npm ci
```

The decision console is deterministic and needs no model credentials. It
starts in public, read-only watch mode; running the demo requires operator
sign-in.

1. Choose a long operator passcode and generate its SHA-256 hash (the
   command prints the hash plus the exact line to paste):

   ```sh
   npm run hash -- 'your-long-operator-passcode'
   ```

2. Add the following to `.env.local` in the repository root, replacing the
   placeholder with the generated 64-character hash. This file is gitignored;
   store the hash here, not the passcode itself. Next.js loads it automatically.

   ```dotenv
   WD_OPERATOR_PASSCODE_HASH=<paste-the-generated-hash>
   ```

3. Start the console:

   ```sh
   npm run console
   ```

4. Open **http://localhost:3100**, expand **Operator sign-in**, enter the
   original passcode, and select **Sign in**. **Run the demo** then appears.
   Use `localhost` for local browser access; the session cookie is `Secure`.
   Restart the console after changing `.env.local`. Without a valid hash,
   sign-in fails closed and the console stays read-only.

```sh
# Tests (all offline; CI runs the same plus the contention proof)
npx tsc --noEmit
npm run test:auth          # operator sessions, mutation guards, login rate limit
npm run test:console       # engine: branches, idempotency, crash recovery, reset
npm run test:artifacts     # schema validation incl. tamper-rejection
npm run test:consumption   # consume-once claims, races, expiry, replay
npm run test:live-loop     # the live script's decision flow (synthetic runtime)
npm run test:bridge        # bridge intake: strict envelopes, run kind, attribution
npm run test:outbox        # outbox: one-tx intent, exact replay, unknown retention
npm run test:bridge-record # non-HACP operation receipts, boundary enforcement
npm run scenario           # end-to-end artifact spine, deterministic
```

### Postgres backend (optional)

The console stores runs and consumption receipts in SQLite by default
(zero-config local demo). Setting `WD_STORE=postgres` swaps in the Postgres
adapters for the hosted demo — engine logic is unchanged:

```dotenv
WD_STORE=postgres
WD_PG_URL=postgres://user:password@host:5432/database   # or DATABASE_URL
# Discrete fallbacks: WD_PG_HOST / WD_PG_PORT / WD_PG_USER / WD_PG_PASSWORD / WD_PG_DATABASE
```

Both stores live in the same database; the adapter creates its tables
idempotently on first use (`initialize`). The Postgres suites mirror the
SQLite contract — claims and contention semantics included — and run against
any disposable database, skipping green when unset:

```sh
WD_TEST_PG_URL=postgres://postgres@127.0.0.1:55440/wd_test npm run test:pg
```

### Real-model pass (Bedrock)

```sh
WD_PROVIDER=bedrock AWS_PROFILE=who-decides npm run live-loop
```

One real agent run end to end: invocation A stops at exactly one
`HUMAN_DECISION_REQUIRED` interrupt, a scripted decision is claimed exactly
once (the claim gates execution), invocation B resumes from the session and
executes only the approved branch as a dry-run. Artifacts land in
`.tmp/live-run/<tag>/`. Set `WD_LIVE_TAG` (filename-safe slug) to name a run;
rerunning a consumed tag stops typed. An OpenAI-compatible escape hatch exists
via `WD_PROVIDER=openai-compatible` with `WD_BASE_URL`/`WD_MODEL`/`WD_API_KEY`.

## Bridge intake (external decision requests)

The console also accepts decision requests from an external system — built
for the chopin bridge work demo. A machine principal submits a typed
envelope; a **bridge run kind** holds it for the operator exactly like a
native run, under the same single-active-run rule:

```sh
# Provision the bridge token (same hash discipline as the operator passcode):
npm run hash -- 'your-long-bridge-token'
# → WD_BRIDGE_TOKEN_HASH=<64-hex> in .env.local; unset = route refuses everything
```

- `POST /api/external/decisions` accepts `who-decides.decision-request.v0`
  (question, option IDs, a coordination binding of document/question/
  revision, context refs, digests). Validation is strict —
  `additionalProperties: false` everywhere, so the envelope structurally
  cannot carry an actor. Authentication is the `machine:chopin-bridge`
  principal via `WD_BRIDGE_TOKEN_HASH` (fail closed: unset/malformed hash →
  typed 503; missing/wrong token → typed 401). This is a distinct scoped
  credential from the AgentCore runtime's `WD_MACHINE_TOKEN_HASH` — neither
  can authenticate as the other's principal. The route has **no application
  rate limiting** — machine authentication is its only gate; the operator
  passcode rate limiter does not cover it.
- The operator answers bridge runs through the same console decision form
  (operator passcode session). Actor attribution always comes from that
  session channel — never from anything the caller sent. The machine
  principal that delivered the request is recorded separately.
- The **outbox** commits the decision and its outbound intent in one
  transaction; dispatch replays only the exact persisted payload (the
  intake-time revision — never a fresh read); a lost response leaves the
  outcome `unknown`, retained until the receiver's idempotency confirms the
  original result on retry. `/api/replay` remains a refusal probe.
- Confirmed operations write a `who-decides.bridge-record.v0` receipt
  (target, operation, idempotency key, payload/result digests, approver *as
  asserted by the bridge*).

**Demo boundaries (bridge):** the bridge run kind produces **no HACP-schema
artifacts** — its records are who-decides' own bridge schemas, explicitly
non-HACP until an honest mapping exists. The approver on a bridge record is
who-decides' operator-session attribution, labeled *asserted-by-bridge*; the
target system records its own identity, and the two are never conflated.
Bridge-run state and artifacts are public reads like all console evidence.

## Review loop

Pull requests are reviewed by Codex under the
[ACK](https://github.com/joefeser/agent-control-kit) lane under
`.agent-control/lanes/pr-review-loop.yaml` (see
[docs/ack-startup-guide.md](docs/ack-startup-guide.md)). Normal feature PRs
target `dev`; promotion to `main` is a separate human-mediated PR. Merge
commits only, never squash. Qodo remains disabled.

## How this was built

The build is a human-gated multi-agent loop: implementation sessions do the
work, independent bot and agent reviewers attack each PR, and the human
owner triages, dispositions, and merges. Everything below is sourced from
[docs/spike-log.md](docs/spike-log.md) — the day-by-day evidence record;
claims without a recorded measurement are marked TODO rather than guessed.

**Models (roles).** Bedrock `global.anthropic.claude-sonnet-4-6`
(us-east-1) is the documented default agent model, adopted after a
measured commit-or-pivot gate (spike-log Day 2b). An OpenAI-compatible
endpoint (gpt-4o, smoke-tested Day 1) remains the escape hatch via
`WD_PROVIDER=openai-compatible`. The decision console itself calls no
model — it replays a fixture deterministically.

**Prices (only what was measured).** The Day 2b gate recorded 7,206 input
/ 2,152 output tokens ≈ **$0.054** per full run at the then-listed $3/$15
per-million-token rates, against a $5 ceiling. The Day 4 end-to-end pass
(both invocations, 5.6 s) was "in line with" that measurement; no exact
figure was recorded for it. AgentCore Runtime was surveyed (Day 7) at
$0.0895/vCPU-hour + $0.00945/GB-hour with a 128 MB floor. TODO: later
passes recorded no per-run cost measurements, and total spend is not
tracked in this repository.

**Review claims (what actually converged).** Not every PR converged
cleanly, and the log says so. Convergence examples with receipts: PR #1
(console) — 11 bot findings triaged, 8 patched in the PR. PR #4 (live
loop) — eleven review rounds across Codex/Qodo passes, including two
reviews wrongly called clean before the real findings landed; the loop
produced the claim-first restructure, durable crash recovery, and the
no-takeover reservation posture. PR #13 (public demo) — 13 findings
across three passes. PR #15 (Postgres adapters) — two Codex rounds plus
an independent second-family pass, verified 88/88 SQLite + 49/49
Postgres. AC-1 (agent service) — three review rounds. PR #10 merged only
by explicit owner override after repeated rounds kept surfacing real
findings — the ceiling on review is the human's, by design.

**Deployed-agent evidence.** The AgentCore packaging repair (Node 22
ARM64 container, native SQLite) is validated by local gates — unit
suites, build, `agentcore validate`, and a container smoke test — and by
the strict live gate. `npm run test:agentcore-live` (see
[deploy/PROVISION.md](deploy/PROVISION.md) and
[agentcore/DEPLOY-CHECKLIST.md](agentcore/DEPLOY-CHECKLIST.md)) ran
against the deployed container runtime on 2026-09-09 and passed **6/6,
0 skipped, 26.8 s** — a real A → human decision → B cycle through the
production dispatcher and `ConsoleEngine`, plus duplicate/conflict/
rejection discipline on typed dispatches (spike-log Day 10).

## Demo boundaries (honest scope)

The decision console (`npm run console`, port 3100) is a **single-operator
demo with public watch mode**:

- State is publicly readable. Starting runs, submitting decisions, resetting
  the console, and probing duplicate resumes require a server-side operator
  session issued after passcode sign-in. Sessions expire after 12 hours;
  the browser carries a `Secure`, `HttpOnly`, `SameSite=Strict` cookie.
- Authenticated console decisions record the originating operator session in
  the HACP human-decision artifact. This is shared-passcode authentication,
  not individual user accounts. Engine/CLI callers without an authenticated
  channel retain explicit `demo-unauthenticated-local-console` attribution.
- Public hosting requires HTTPS and the reverse proxy setup in
  [deploy/PROVISION.md](deploy/PROVISION.md). `npm run console` is the local
  development server; the hosted deployment uses a production build.
- Preparation and verification are fixture simulations. Task-packet initial
  approval hashes are illustrative, not signature verification. Runtime machine
  authentication proves the relay credential, not an independently verified
  human act; the console retains the originating operator-session decision.
- Live mode uses both `WD_AGENTCORE_ENDPOINT` and `WD_MACHINE_TOKEN`. Live
  runs advance only on confirmed AgentCore responses; failures stay visible.
  Unset both variables and restart for deterministic mode. See
  [the deployment checklist](agentcore/DEPLOY-CHECKLIST.md).
- Live mode keeps **two artifact spines**: the console persists its own
  decision → consumption-receipt → effect-receipt chain (whose
  `successorInvocationId` is the console's reserved claim successor), while
  the AgentCore runtime persists its own spine with its own invocation IDs.
  The spines are joined by the run tag embedded in the runtime's decision ID
  and by the full dispatch envelopes the console stores per invocation —
  not by sharing one invocation ID space.
- If a live resume is confirmed remotely but the console dies before
  finalizing, resubmitting the same decision repairs the run idempotently
  (no redispatch). A terminal claim rejection parks the run as `blocked`,
  which reset may archive; audit artifacts are retained either way.
- The prepared effect is always a **dry-run**: the exact payload is recorded and
  shown, and no external mutation is performed in any branch.
- Bridge runs (see [Bridge intake](#bridge-intake-external-decision-requests))
  produce no HACP-schema artifacts; their records are explicitly non-HACP,
  and their approver field is an assertion by this bridge's operator session,
  not an identity the target system verified.
- Resetting the console archives the current run; completed run records and
  artifacts stay in the local database for audit.

## Pre-existing work (disclosed)

This repository is a new project, but it builds on disclosed prior work by the
same author and on open-source libraries. See [docs/disclosure.md](docs/disclosure.md)
for the full list, notably:

- [HACP — Human-Approved Coordination Protocol](https://github.com/joefeser/hacp):
  pre-existing conceptual work. Its machine-readable schemas (Apache-2.0) are
  incorporated here with attribution and drive the typed artifacts in this demo.
- [Strands Agents SDK](https://github.com/strands-agents) (Apache-2.0, AWS).

## License

Apache-2.0 — see [LICENSE](LICENSE).
