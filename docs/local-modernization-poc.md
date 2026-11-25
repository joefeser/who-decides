# Customer-local modernization PoC

Status: planned. Local foundation proof comes first. Prepared November 24, 2026.

## Objective

Give humans and agents a durable, customer-held record of extracted evidence, unresolved findings, decisions, work progress, and verification. Prove local operation and restart recovery before connecting legacy migration work. Who-Decides supplies the small decision bridge for this experiment. WITS integration is deferred.

## Deployment contract

The first supported profile is one host, loopback browser access, local checkouts, local artifact directories, and separate SQLite files owned by Chopin and Who-Decides. TraceMap retains its existing scan outputs and index.sqlite. Applications communicate through supported interfaces and reference artifacts by identity and hash.

The acceptance run blocks outbound networking and removes GitHub/App/PAT and hosted-model credentials. Pre-stage dependencies, browser assets, tools, and fixtures before disconnecting. Capture both blocked attempts and successful traffic. Required paths must operate without attempted external calls; unavailable online actions must give explicit local feedback.

The first worker is deterministic and model-free. A local model is a later optional addition. A customer-approved hosted model would be a separately named connected profile. Customer artifacts, source, decisions, backups, and logs stay in customer custody. Public issues and docs contain synthetic or public fixture information only.

## Ownership

- Chopin owns local document/card state, local workspace access, authenticated human and machine identities, and revision-checked mutations.
- Who-Decides owns the operator decision and reliable delivery record. Retain human actor and machine delivery actor as distinct identities.
- TraceMap owns deterministic extraction, provenance, coverage, and explicit gaps.
- A small workflow integration initially housed in Who-Decides associates findings, decisions, artifacts, and worker checkpoints. It derives continuation from persisted records.
- Human approval records an authorized choice. Extraction findings retain their original evidence tier and uncertainty.

## Delivery order

### M0 — reconcile requirements

Record current behavior and planned changes in each repository. The owner's November 24 direction supersedes the earlier bridge-only exclusion of Chopin identity changes for this PoC. Keep historical receipts intact and add scoped supersession pointers. Existing local-owner candidate contracts retain their narrowly declared meaning.

### M1 — independent local foundations

Chopin gets an explicit local-only identity/workspace profile and a SQLite adapter behind existing interfaces. GitHub installation, repository-role, token renewal, repository tools, and publication assumptions need an inventory. Local workspace permissions replace those dependencies in this profile.

Preserve atomic document/decision commits, revision conflicts, idempotent operation IDs, writer exclusion, leases/fencing as applicable, and crash recovery. Define the supported single-host concurrency and backup/restore procedure. SQLite is an implementation milestone rather than a current Chopin capability.

Who-Decides uses its existing SQLite support, authenticated private reads, and local Chopin machine credentials. Use explicit profile selection so historical public demo behavior and the new private profile are accurately documented.

### M2 — first acceptance gate

With outbound networking blocked:

1. Start both applications with separate SQLite files and no GitHub or hosted-model credentials.
2. Authenticate a local operator and register a local checkout with a stable workspace identity.
3. Create a document and one decision card through supported interfaces.
4. Have the local worker read the card and submit a bounded request.
5. Have the human approve or reject it in Who-Decides.
6. Deliver the exact recorded answer to Chopin and read back the settled revision and actor records.
7. Restart both services and the worker. Recover the same decision and continuation state.
8. Inject a lost response and duplicate retry. Confirm one settlement and an honest unknown outcome until readback establishes delivery.
9. Change the reviewed revision and prove the stale answer is refused.
10. Deny unauthenticated state/artifact access, a wrong machine credential, and an out-of-workspace request.
11. Export and restore the local state and confirm the same evidence and decision references.

Record actual human acceptance separately from automated fixture checks. The gate passes when all observations have evidence, recovery succeeds, and the tested required paths have zero external dependency attempts. Keep failure reasons visible.

### M3 — migration flow after M2

Select one public DNN Web Forms module and one read/edit/save operation. Qualify its pinned source, binaries, build, runtime, and license before treating it as the acceptance fixture. Use the existing TraceMap DNN corpus for known partial-analysis cases where useful.

Import a retained scan, project one finding into a card, attach a human review decision, execute one bounded transformation, and capture frontend/backend verification. Restart with a fresh worker and recover pending work. A changed input must flag affected evidence and decisions for reconsideration.

Retain TraceMap JSON, SQLite, Markdown, manifests, and logs as evidence artifacts. Create additional extraction work only for demonstrated gaps. Use existing workspace collection and migration evidence rather than duplicating them.

## Proof and implementation records

Each story records its branch, exact source revision, completed checks, remaining gaps, and next step. Scope each implementation PR to a completed story or reviewed slice. Update task status with evidence. New machine-readable derived receipts must bind generator and input hashes; public exports hash only privacy-projected inputs.

## Upstream maintenance

Chopin and Who-Decides branches start at fresh origin/dev in isolated worktrees. Favor provider interfaces and small changes that survive Chopin upstream merges. Keep existing GitHub/PostgreSQL implementations available for their supported profiles. Add local behavior and test it independently.

## Documentation reconciliation

- Chopin AUTH_MODE=local currently means GitHub device login. Use a distinct explicit profile name for offline behavior and document the difference.
- Chopin currently has only a PostgreSQL runtime adapter. Update this statement when SQLite actually lands.
- Who-Decides currently exposes demo evidence publicly. Update private-profile read semantics together with route enforcement.
- Who-Decides local-owner continuation candidate authorizes a fixed model-free observation. Reuse suitable primitives without claiming that candidate already permits arbitrary worker execution.
- The earlier C3 identity exclusion is a historical scope decision. Add a scoped supersession note where the original record is located; the owner-supplied excerpt alone does not establish its file location.
- TraceMap's historical Base44 implementation-state header still says review pending while later issue receipts report delivery. Reconcile individual entries against linked PRs, while keeping downstream acceptance gaps explicit.
- Existing one-use grants, prior deployment receipts, and human sign-offs remain scoped to the work they actually covered.

Discuss any broader product-policy deletion or ambiguous historical ruling with the owner before removing it. Routine factual documentation corrections can follow verified implementation and PR evidence.

## Stories

- [ ] [chopin #1 — [Local PoC M1] Add local identity, workspace access, and machine authentication](https://github.com/joefeser/chopin/issues/1)
- [ ] [chopin #2 — [Local PoC M1] Implement durable SQLite storage with recovery contract tests](https://github.com/joefeser/chopin/issues/2)
- [ ] [who-decides #42 — [Local PoC M1] Protect private evidence and deliver decisions with local Chopin credentials](https://github.com/joefeser/who-decides/issues/42)
- [ ] [who-decides #43 — [Local PoC M2] Prove offline card decision and restart continuation end to end](https://github.com/joefeser/who-decides/issues/43)
- [ ] [who-decides #44 — [Local PoC M3 deferred] Connect findings, decisions, and resumable transformation work](https://github.com/joefeser/who-decides/issues/44)
- [ ] [tracemap #952 — [Local PoC M3 deferred] Qualify a public Web Forms fixture and retained evidence handoff](https://github.com/joefeser/tracemap/issues/952)
- [ ] [tracemap #953 — [Local PoC M0] Reconcile historical specs and current modernization evidence status](https://github.com/joefeser/tracemap/issues/953)

## Branch baseline

Planning branch `codex/local-modernization-poc` starts from `origin/dev` at `81391a51d499e22fa10bea2a0a224ee8f468fd55`. Implementation and M2 acceptance are pending. The linked tracker holds the shareable plan while this document is under development.

