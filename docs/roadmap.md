# Roadmap

Status of the build, gated by a technical spike. The entry is capped at three
focused days; anything that doesn't fit is cut.

## Spike (gate: go/no-go)

Prove the four load-bearing pieces with the Strands TypeScript SDK:

1. A Strands agent with custom tools runs a bounded job and terminates by
   emitting a typed decision request (terminal output, not a pause).
2. Session state survives process exit and restart.
3. A resume invocation is seeded with the prior session plus the human's
   decision record.
4. Artifacts validate against the HACP JSON Schemas (`task-packet`,
   `human-decision`, `agent-report`, `stop-response`).

If resume-as-new-invocation proves awkward, mid-run interrupt/resume is a
fallback, not a requirement — see the design debate record.

## Day 2 — the demo workflow

One repetitive, judgment-heavy professional workflow, end to end. Candidate:
PR review triage / task-packet execution. Decision pending the design debate.

## Day 3 — polish

- Minimal decision console: render the decision packet, Approve/Reject,
  trigger resume. (Design criterion is 1/5 of the score — cut last.)
- Architecture diagram, README finalization.
- ≤5 minute demo video: problem, the stop, the human decision, the resume,
  the report. (Presentation is also 1/5 — half a day reserved.)

## Cut line

If the spike fails, this repo stays a spike and we don't submit.
