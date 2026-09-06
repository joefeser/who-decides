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
[docs/spike-log.md](docs/spike-log.md) for evidence.

## Quickstart

```sh
npm install
```

The decision console is deterministic and needs no model credentials. It
starts in public, read-only watch mode; running the demo requires operator
sign-in.

1. Choose a long operator passcode and generate its SHA-256 hash. Replace the
   placeholder below with your chosen passcode (this command works on macOS
   and Linux with Node installed):

   ```sh
   node -e 'console.log(require("node:crypto").createHash("sha256").update(process.argv[1]).digest("hex"))' 'your-long-operator-passcode'
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
npm run test:auth        # operator sessions, mutation guards, login rate limit
npm run test:console     # engine: branches, idempotency, crash recovery, reset
npm run test:artifacts   # schema validation incl. tamper-rejection
npm run test:consumption # consume-once claims, races, expiry, replay
npm run test:live-loop   # the live script's decision flow (synthetic runtime)
npm run scenario         # end-to-end artifact spine, deterministic
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

## Review loop

Pull requests are reviewed by Codex and Qodo before merge, with an
[ACK](https://github.com/joefeser/agent-control-kit) lane proposal under
`.agent-control/lanes/pr-review-loop.yaml` (see
[docs/ack-startup-guide.md](docs/ack-startup-guide.md) — the lane is
committed but not yet activated). Merge commits only, never squash; main is
human-mediated.

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
- The prepared effect is always a **dry-run**: the exact payload is recorded and
  shown, and no external mutation is performed in any branch.
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
