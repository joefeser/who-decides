# Local setup validation — 2026-11-24

The synthetic local flow passed on macOS with external networking denied by the OS. This is a local setup/recovery result, not human acceptance or migration qualification.

Implementation commits:

- [Chopin 6cb9a192](https://github.com/joefeser/chopin/commit/6cb9a192237390315ae2b0182cd2e781a1b56d19)
- [Who-Decides 54ae249](https://github.com/joefeser/who-decides/commit/54ae249301a0a4212ae8ae619a9e1210c267f2d2)

Both tracked diffs were empty during the final proof. Bun 1.4.5, Node 24.22.1, staged dependencies, and production web assets were used. No GitHub or model credential was supplied to either process. A non-loopback TCP probe returned EPERM.

## Observed results

- Normal HTTP local human sign-in and distinct machine credentials; wrong machine credentials and foreign workspace access refused.
- Private state/artifact reads require operator authentication.
- MCP document creation, idempotent decision request, stale answer refusal.
- Both applications restarted with a pending decision; encrypted sessions and the request survived.
- Approval committed in Chopin while its response was deliberately dropped. Both applications were then killed with SIGKILL. After normal lease expiry, the exact persisted request recovered the original settlement.
- Two wire attempts produced one approval settlement; a duplicate resume caused no third dispatch for that decision.
- A second, independent rejection settled with the rejected option preserved. Total: three wire attempts, two independent decisions.
- A fresh worker process observed the settled card.
- Both apps stopped, databases copied, and restored apps returned the same settlement and confirmed outbox state.
- Browser automation rendered the local sign-in screens. No actual human acceptance is claimed.

The private proof receipt records the generator SHA-256 `488a309e3c14a3d5f4e6cd676bb25d5f46ea8a44920ae265566bc31d8b27d14a` and synthetic bounded input SHA-256 `7c15bef316f60d561c6704c33f6487f71ed206e089b94689228f50add50a99ad`. It contains no customer input. Runtime credentials and raw logs remain untracked.

## Test results and limits

- Who-Decides default suite: 194 passed, no failures. Type checking and production build passed.
- Chopin focused auth, MCP, SQLite/shared storage, memory, and visual-admission suite: 692 passed, no failures. Workspace type checks, web build, and repository CI checks passed. CI still reports existing lint/design baseline warnings.
- The wider Chopin server/packages/web run reported 9,309 passed, 8 skipped, and 2 failures. One was an incorrect new test assertion, corrected and included in the passing focused rerun. The other needs the unavailable host `flock` executable. This wider run was not rerun in full after that correction and is not a green full-suite result.
- The all-repository run also encountered connector/install fixture failures, missing `wget`/`flock`, path canonicalization differences and timeouts; it was stopped. PostgreSQL tests were not qualified against a live database.
- Crash after remote commit is covered; a precisely injected crash inside SQLite COMMIT is not separately demonstrated.
- SQLite is a 64 MiB, runtime-version-bound checkpoint adapter for a small single-host workspace. Large-site throughput, schema/runtime migration, and rolling upgrades remain unqualified.
- Worker recovery after a received/persisted run ID is covered. Lost intake response before the worker saves that ID remains a distinct recovery gap.
- No migration, employer scan, model execution, or hosted deployment occurred. Stories stay open for acceptance review; actual human sign-off remains pending.

Use [the setup runbook](private-local-setup.md) to start the pair and repeat the proof. The supervisor runs in the foreground and stops its own children on exit.
