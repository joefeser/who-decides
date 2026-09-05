# Local owner continuation candidate

`LocalOwnerVerifier` is the only surface implementing the explicitly selected
`org.hacp.local-owner-continuation / 0.1-candidate` contract pinned at HACP
`3b61e64d61984f0c5617c4a71266802f31961494`. The profile SHA-256 is
`bc02b5972c2ac1184637062b3dabf7a655ae442cb6fa22940d8d119f678483ec`.
It is a local library and has no HTTP, console, live-loop, provider, command, or
network integration.

The configured credential authenticates access; the configured issuer and
actor supply identity. Callers cannot select either. Human decisions are
installed from owner-controlled configuration into a distinct trusted local
store and atomically reserved when used. An unchanged closed HACP
v0.1 human `start_work` decision must bind the candidate decision, packet and
fixed action. Its detached companion digest uses the candidate's published JCS
domain; it is not described as a native field or digest of the base format.

The SQLite database uses one slot per issuer and decision ID. A legacy
`consumption_receipts` row with the same decision ID blocks admission while the
shared SQLite write transaction is held. Legacy bytes are never rewritten.
Claims bind every field to the slot; exact retry only returns the original
record. A verifier instance that did not admit the claim cannot start it.

Every mutation takes a per-decision exclusive filesystem guard. Start keeps the
same guard from status/clock validation through a `synchronous=FULL` intent
commit, a second status/clock check, and the synchronous comparison returning
the fixed observation. The intent derives and records a monotonic deadline from
the earlier decision/claim expiry; wall or monotonic equality denies handoff.
Status writers use the same guard. A crash leaves the
guard in place and it is never reclaimed automatically. The intent is admission,
not evidence that observation occurred. Results separately record `completed`
or `uncertain`; replay and restart stop for human inspection.

The five executable schemas under `schemas/local-owner/` are separate candidate
records. Existing closed base schemas and product paths remain unchanged.
This implementation does not prove remote trust, provider exactly-once effects,
release readiness, deployment, migration, or owner acceptance.

## Proof evidence integrity

The v2 proof marks a fixture observed only when the exact fixture ID has a
passing unit or child-process receipt. This is a regression boundary for
`EVIDENCE_INTEGRITY — proof observed labels outran test bodies`. The current
non-architecture gate observes 43 of 44 fixtures. It leaves
`legacy-insert-races-profile-admission` uncovered and makes no cross-store or
same-file migration claim while that architecture decision is under review.
