# Roadmap

who-decides is **built and submitted** for the hackathon, and serves as the
v0.3.0-candidate reference implementation of HACP — its evidence is pinned at
exact heads and proof SHAs in the published HACP v0.3.0-candidate packet.
This file is a status record; implementation evidence lives in
`docs/spike-log.md` (Days 1–7).

## What shipped

- **Interrupt spike** — `@strands-agents/sdk@1.16.0` interrupt/snapshot tests
  met the M1 bar cross-process: mid-run pause is a terminated invocation
  carrying durable pending state, and replay proved consume-once semantics
  are ours to build.
- **Bedrock gate** — the 7-item commit-or-pivot gate passed: COMMIT on
  `global.anthropic.claude-sonnet-4-6` at ~$0.054/run vs the $5 ceiling;
  AgentCore recorded as a disclosed stretch, never load-bearing.
- **Artifact spine** — five HACP v0.1-draft artifact families vendored and
  attributed, ajv validation pipeline, fixture scenario, deterministic
  end-to-end runner, and tamper-rejection tests.
- **Decision console** (PR #1) — three-state human decision console wired to
  the spine; only the approved branch ever executes.
- **Live loop** (PR #4) — a real Strands agent on Bedrock end to end: typed
  interrupt, human decision, claim-first consume-once gating, and honest
  reports (`surfaces_changed`, never phantom `files_changed`).
- **Tenant scoping** (PR #6) — known-tenant isolation for the console engine.
- **Storage seam** (PR #7) — async storage provider seam over SQLite
  adapters; the seam a Postgres adapter plugs into.
- **Local-owner verifier** (PRs #8–#10) — authenticated local continuation
  guard, receipt-bound evidence-integrity proof, and same-file legacy
  admission enforced; the proof inventory closed at 44/44.
- **ACK lane** (PR #5) — main-only PR-loop lane proposal and startup guide.

## What's next

- **Public demo behind the 9/11 gate:** AgentCore Runtime deploy (serverless
  microVM, terminate-on-stop — the same shape as the M1 ruling), operator
  auth for the console (issue #2 boundary), and a Postgres adapter behind the
  PR #7 seam.
- **HACP promotion criteria** (candidate → release): a second independent
  implementation; same-file legacy migration exercised in a real eligible
  deployment; real-effect semantics separately specified and proven.
- **Post-hackathon:** per-visitor runs and a decision queue.
