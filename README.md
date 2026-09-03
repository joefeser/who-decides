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

Early spike — being built for the [Agents for Humans](https://agentsforhumans.devpost.com/)
hackathon (AWS / Strands Agents SDK), September 2026. See [docs/roadmap.md](docs/roadmap.md)
as it fills in.

## Demo boundaries (honest scope)

The decision console (`npm run console`, port 3100) is a **local, single-operator
demo** and says so plainly:

- The HTTP API has **no authentication** and no session binding. Whoever can
  reach the port can submit a decision. Binding decisions to an authenticated
  operator session is tracked as real follow-up work, not pretended here.
- The HACP human-decision artifacts therefore carry demo attribution: the
  v0.1-draft vocabulary has no "unauthenticated local console" actor
  verification value, so the artifact's free-text session references say
  `demo-unauthenticated-local-console` rather than fabricating a real session.
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
