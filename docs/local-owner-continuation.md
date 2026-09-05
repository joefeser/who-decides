# Local owner continuation candidate

`LocalOwnerVerifier` is the only surface implementing the explicitly selected
`org.hacp.local-owner-continuation / 0.1-candidate` contract pinned at HACP
`de8a2a7a0104d4f1a67f866d20d32ebf30ee8752`. The profile SHA-256 is
`18dedc4a2ef445e142ef395c62883d3448ad0ee021dbde789fe6b14e94538c34`.
It is a local library and has no HTTP, console, live-loop, provider, command, or
network integration.

The configured credential authenticates access; the configured issuer and
actor supply identity. Callers cannot select either. An unchanged closed HACP
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
the fixed observation. Status writers use the same guard. A crash leaves the
guard in place and it is never reclaimed automatically. The intent is admission,
not evidence that observation occurred. Results separately record `completed`
or `uncertain`; replay and restart stop for human inspection.

The five executable schemas under `schemas/local-owner/` are separate candidate
records. Existing closed base schemas and product paths remain unchanged.
This implementation does not prove remote trust, provider exactly-once effects,
release readiness, deployment, migration, or owner acceptance.
