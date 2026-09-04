# Consumption integrity repair and bounded proof

This repairs the local consumption store used by the console and PR #4's
live-loop. The base HACP schemas and decision-ID uniqueness slot are unchanged.
It does not establish authenticated approval, guarded start, revocation,
ambiguous-effect recovery, provider exactly-once effects, or HACP v0.3 readiness.

## Behavior

Both the ordinary existing-row path and the insert-constraint race path compare
the submitted decision's digest with the stored digest column and receipt digest,
and check the decision/request/action and successor binding. Changed content
returns `digest_mismatch`, even when the caller supplies a digest matching that
changed content. An identical current-encoding decision and successor returns
the exact original receipt. Another successor is rejected. Receipt replay alone
does not authorize execution again.

The local digest encoding now starts with the domain `who-decides.decision.v1`
and includes all seven declared DecisionRecord fields, with absent `expiresAt`
represented explicitly as null. It hashes fixed-order JSON; this is not a claim
of HACP JCS conformance or an approved issuer/scope profile. Expiry changes or
removal invalidate a previously submitted digest. Expiry must be an actual
RFC3339 calendar timestamp with a timezone; invalid dates, calendar rollovers,
and unsupported leap seconds fail closed. Claim-time expiry remains distinct
from a serialized validity check at successor start, which is unsupported.

## Historical compatibility

Existing receipt JSON and rows are never migrated, deleted, or rewritten.
`getReceipt` still returns historical records unchanged. **Replay of all legacy
six-field-digest receipts is rejected**, including decisions presented without
expiry. The old digest omitted expiry, so a genuine old no-expiry decision
cannot be distinguished from an expired decision with expiry stripped. Retaining
successful legacy no-expiry replay would preserve that integrity gap. The new
domain prevents a historical digest from being silently treated as corrected
proof. Historical expiry receipts are never upgraded. This is an intentional
replay compatibility break, including for old console runs awaiting recovery;
operators must retain their records and obtain a new explicit decision rather
than delete a claim or automatically retry. No migration authority is inferred.

## Reproduce without models or effects

From the repository, with locked dependencies installed:

```sh
npm run test:consumption
npm run test:console
npm run test:artifacts
npx tsc --noEmit
npm run scenario
npm run proof:consumption -- .tmp/consumption-proof
```

The proof output directory must be new; prior results are never overwritten.
The process proof runs three competing-successor races, a changed-action race
with the same successor, and an identical-retry race. A parent holds a SQLite
write lock while two independent child processes both observe an empty claim
slot. Test-only SQL wrappers record those reads and the losing insert's primary
key conflict. Each trial must persist exactly one receipt. After both children
exit, a fresh process must replay the winner's exact receipt. The changed-action
case also verifies rejection on the ordinary existing-row path.

`result.json` includes synthetic inputs, process IDs, timings, observed SQL
boundaries, receipts, fresh-process replay, git HEAD, tracked-diff hash and exact
source/harness/lockfile hashes. Dirty-tree evidence is identified by its hashes;
HEAD alone is not represented as its implementation revision. CI uploads the
JSON as a seven-day artifact. Existing sequential CLI tests are labeled as such.

The unit regressions cover changed action/request/choice/rationale/time/expiry,
extending or removing expiry with the old digest, malformed dates and invalid
calendar days, and byte-for-byte retention of legacy receipts. None of these
checks proves missing-readback rejection at successor start, revocation/start
ordering or durable ambiguity/no-reexecution. Those require separately reviewed
policy and implementation. Two independent reviews and owner acceptance of a
complete pinned packet remain outstanding.
