# Private local setup and restart proof

This PoC runs Who-Decides and Chopin on loopback with separate SQLite files. It uses local human and machine identities. GitHub, PostgreSQL, model calls, WITS, and migration execution are not part of this profile. The hosted/demo profiles remain available separately.

## Prepare once, while dependencies are available

Use the `codex/local-modernization-poc` branches in both repositories. Install the repositories' pinned dependencies and build the clients before disconnecting:

```sh
# In Chopin, with Bun 1.4.5:
bun install --frozen-lockfile
bun run --filter '@chopin/web' build

# In Who-Decides, with Node and its installed SQLite native module:
npm ci
NEXT_TELEMETRY_DISABLED=1 npm run console:build
```

The observed proof used Bun 1.4.5 and Node 24.22.1 on macOS. Who-Decides' existing package engine declaration is Node 22; Node 22 has not been newly qualified by this proof. Use the same Node ABI used when installing `better-sqlite3`. Dependencies and browser assets must already exist for offline operation.

## Start and stop

From Who-Decides:

```sh
export LOCAL_PROOF_BUN="$(command -v bun)"
npm run local:start -- /absolute/path/to/chopin
```

The foreground supervisor starts Chopin at `http://127.0.0.1:18798` and Who-Decides at `http://127.0.0.1:13100`. It supplies only explicit local configuration, with each server inside the tested macOS `sandbox-exec` policy denying non-loopback networking. It does not change a system firewall or start a service. Ctrl-C stops both processes; an application exit stops its peer. Restart with the same command and data directory to resume.

Default data directory: `.tmp/private-local`. An optional final argument selects another directory. Keep it private. It contains both databases, the session encryption key, local identity configuration, and separate 0600 credential files. Do not commit or share it.

- Chopin sign-in: local user `operator`; passcode in `chopin-passcode.txt`.
- Who-Decides sign-in: passcode in `operator-passcode.txt`.
- `bridge-token.txt` is the machine credential for Chopin; it cannot sign in as the human.
- `directory.json` declares explicit `local/name` workspaces and each principal's read/write grants. These are local identities, not GitHub repositories or roles. Restart after editing grants or rotating credentials.
- `secrets.json` also holds Who-Decides' distinct machine intake credential. Do not reuse it as an operator or Chopin bearer.

This supervisor currently requires macOS. A Linux/Windows launcher must supply and verify equivalent OS egress isolation before claiming this offline proof there. Loopback isolation is not a multi-user host security boundary; a hostile local proxy or administrator is outside this PoC.

`WD_PROFILE=private-local` requires operator authentication for both `/api/state` and `/api/artifacts/:name`. Missing or misspelled profiles do not silently select private mode: the ordinary unset profile remains the public demo. Use the supervisor for private runs. A misspelled value fails startup. Hosted agent dispatch and PostgreSQL configuration are refused in private-local mode.

## Worker and human flow

A local worker uses Chopin's existing MCP `create_document` and `read_coordination_snapshot`. The offline-only `POST /api/offline/decisions` accepts a document ID, ULID request ID, single-line question, and 2–4 identified choices. It checks the machine's workspace write grant and requests a card through the existing decision service. It cannot settle the answer. Exact repeated requests return the existing card; conflicting reuse is refused.

The worker submits the resulting question and exact revision to Who-Decides' `/api/external/decisions`, using the separate intake token. A signed-in operator selects a choice. Who-Decides retains the decision and exact outbound payload before dispatch; Chopin retains the settlement before replying. The worker can read the settled card after restarting. The bridge settles as `bridge`; the human session attribution remains in Who-Decides' decision receipt. Transport identity is not the human identity.

## Repeat the automated proof

From Who-Decides with both build outputs present and ports 13100/18798/18799 free:

```sh
export LOCAL_PROOF_BUN="$(command -v bun)"
sandbox-exec -p '(version 1)(allow default)(deny network*)(allow network-inbound (local ip "localhost:*"))(allow network-outbound (remote ip "localhost:*"))(allow network-bind (local ip "localhost:*"))' \
  node scripts/private-local-proof.mjs /absolute/path/to/chopin
```

The proof refuses to proceed unless a non-loopback TCP connection fails with an OS permission error. It creates a fresh private directory and tests:

1. Human sign-in, machine authentication, denied foreign workspace, and private evidence reads.
2. A real MCP-created document and an idempotent machine-requested card.
3. Stale revision refusal.
4. Restarting both apps with a decision still waiting; existing browser sessions and evidence survive.
5. A synthetic operator choice; a local proxy deliberately drops the response after Chopin commits.
6. SIGKILL of both apps, waiting for the dead writer's normal 30-second lease expiry, then exact-payload retry.
7. Exactly two answer wire attempts, one settlement, and a duplicate-resume probe with no third dispatch.
8. A fresh worker process reading the settled card.
9. A separate rejection, with its chosen option preserved (three total wire attempts for two independent decisions).
10. Stopped backup/restore into a new directory, then reading the same settlement and confirmed outbox state.

The private `result.json` records the script/input hashes and observed checks. Logs and credentials remain in the ignored proof directory. This is synthetic acceptance through real application routes, **not human sign-off**, and not proof that a migration was performed. The current intake does not yet deduplicate a lost intake response across a worker crash; the automated worker persists its returned run ID before exiting. That separate recovery window remains a follow-up, not an exactly-once intake claim.

## Storage and operational limits

Chopin uses a versioned, Bun-version-bound checkpoint in SQLite, limited to 64 MiB, with WAL and FULL synchronous commits. It reuses the contract engine's domain transitions inside transactions; it is not an unflushed in-memory fallback. It is intended for the small local proof, not large-site throughput. An upstream engine schema change must bump/migrate the checkpoint format explicitly. PostgreSQL conversion and rolling upgrades are not implemented.

Stop both applications before copying databases, identity files, and encryption keys. Do not copy a live SQLite main file without its WAL. Keep backup permissions private. The proof verifies a stopped backup and restore. Preserve the encryption key to retain browser sessions; rotating the local principal secret invalidates that principal's earlier signed session credentials on restart.

Offline authoring validates document syntax and explicit visuals. It skips the hosted model's editorial recommendation of where a visual should be added. This is reported as a distinct offline policy, not as a successful model assessment. Hosted Planner/AI execution and connector provisioning remain disabled/not qualified in this profile.

## Human check before migration work

Follow the [human walkthrough](private-local-human-walkthrough.md) for a repeatable synthetic request and read-only status check. See [recorded validation](private-local-validation.md) for the automated results and limits.

Start the local supervisor, sign in to both apps, inspect a synthetic request and its state/reason, choose an answer, stop/restart, and confirm the same decision is shown. Record the human result separately. No migration flow, private employer scan, PR merge, or deployment is authorized by the proof itself.

## Human reconsideration (local SQLite profile)

Reopen an answered card in Chopin's browser Decisions tab. Who-Decides cannot reopen it over MCP. On the confirmed local bridge screen choose **Check reopened card**: this reads Chopin, checks that `previous` matches the original confirmed answer's choices/actor/time, and opens a fresh held run. It archives the old run without deleting its decision or outbox receipts. The successor links its predecessor through the request's context references. Concurrent observations create one successor atomically.

The tested checkout resets the shared-draft revision to zero on reopen. A cycle therefore binds the prior run and attributed previous settlement, card, current question/options and revision; revision alone is insufficient. A new human choice gets a new run-derived outbox key. Lost-response recovery for that choice still uses the same persisted payload/key. Before recording a fresh choice, the server re-reads the card and refuses if the observed cycle changed. This is a preflight, not an atomic lock across applications: Chopin's answer revision check remains the receiver guard; its revision reuse does not provide a globally unique cycle token. Do not treat this PoC as a concurrent multi-writer approval system.

This optional transition is implemented for SQLite only and exposed only in the private-local profile. Hosted/demo duplicate-resume diagnostics remain unchanged. A mismatched previous answer, unresolved prior delivery, unsupported multi-question card, unavailable read, or changed card stops observation. No implementation approval or migration is performed.

Chopin reopen history projects settlement time to whole seconds, while the confirmed MCP receipt retains milliseconds. Matching accepts that exact whole-second projection (same actor and exact choice set); a different second is refused. The original receipt is preserved unchanged.
