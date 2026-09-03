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

### Joe-side prerequisites for the day-1 Bedrock gate

1. AWS Builder ID + claim the $50 hackathon credits (Devpost Resources tab).
2. AWS credentials available to the default credential chain (env or profile).
3. Bedrock model access enabled for the pinned model in the chosen region.

Once provided: run the 7-item commit-or-pivot gate (RULING M4); same-day
decision; if it fires, default + video + live demo pivot together.
