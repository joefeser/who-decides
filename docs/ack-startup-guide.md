# ACK startup guide — who-decides

The active lane is `.agent-control/lanes/pr-review-loop.yaml`. Version 0.2 adds
only `dev` as the development and owner-handoff target. It does not loosen the
human-mediated `main`, `master`, or `release/**` boundary.

## Verified environment (2026-09-06)

- CLI baseline: stable ACK `>=0.5.1 <0.6.0`; the lane requires the exact
  onboarding, batching, freshness, and release-provenance capabilities it uses.
- After the v0.2 policy PR is merged and `dev` is created from that exact
  approved `main`, normal feature PRs pass `--base dev`.
- Promotion to `main` remains a separate owner-mediated PR. Never treat the
  `dev` eligibility lists as permission to merge or patch `main`.
- Reviewers confirmed installed on this repo: **codex** (chatgpt-codex connector,
  `@codex review` dispatch); **qodo** was the second required reviewer until
  the **Qodo sunset on 2026-09-07** (left the platform; disabled in the lane
  with its history preserved — Codex is now the sole required reviewer with
  unchanged batch semantics and ceilings). Sourcery is
  installed but deliberately disabled in the active lane.

## Startup commands

```sh
agent-control version --json
agent-control doctor --lane-config .agent-control/lanes/pr-review-loop.yaml --json
agent-control onboard doctor  --repo joefeser/who-decides --base dev --json
agent-control onboard explain --repo joefeser/who-decides --base dev --json
agent-control onboard worker-prompt --repo joefeser/who-decides --base dev --compact --goal "one bounded objective"
```

Per-loop handoff (after implementation, on a PR):

```sh
agent-control pr-loop --repo joefeser/who-decides --pr NUMBER --base dev \
  --require-codex-review --quiet --json-decision \
  --handoff-out .agent-control/pr-loop-handoffs/pr-NUMBER.json
```

The policy PR itself targets `main` because `dev` does not exist yet and
head-only policy cannot authorize itself. After Joe merges it, create `dev` in
a separate owner-visible action from the exact post-merge `origin/main` commit:

```sh
git fetch origin main --prune
POST_MERGE_MAIN=$(git rev-parse refs/remotes/origin/main)
git push origin "$POST_MERGE_MAIN:refs/heads/dev"
```

Record `POST_MERGE_MAIN` in the handoff. Do not run this bootstrap command from
the policy PR or create `dev` from its unmerged head.

## Effective lane policy

- **Branch model:** feature branches target only `dev`. Merge method is
  `merge_commit`, never squash. `main`/`master`/`release/**` remain denied for
  overnight and owner-override handling; owner-override auto-merge is disabled.
- **Reviewers:** codex, required and batched — no patch authority before
  `REQUIRED_REVIEW_BATCH_SETTLED`. (Qodo was required until its 2026-09-07
  sunset; now disabled with history preserved.) Codex re-requests are
  policy-gated with a 2-request ceiling. Manual bot retags are forbidden.
- **Fresh fix cycles:** 2 (the generator default of 1 was raised per the
  recommendation).
- **Risky paths:** repo-accurate list in the lane YAML. The generator's
  generic `auth/**`/`migrations/**` globs were replaced — those directories do
  not exist here. Unknown paths need assessment, not a safety assumption.
- **Validation (proves a patch before handoff):**
  `npx tsc --noEmit`; `npm run test:console`; `npm run test:artifacts`;
  `npm run test:consumption`; `npm run test:live-loop`; `npm run scenario`;
  `git diff --check`. CI on main additionally runs `npm run proof:consumption`
  with artifact upload — run it locally whenever consumption-store behavior
  changes.
  **`npm test` runs the full offline suite stack** (console, artifacts,
  consumption, live-loop, local-owner — PR #11); use it as the one-command
  check.

## Boundaries carried from the recommendation

- Kiro reviews are advisory-only unless an owner-admitted exact-head receipt is
  recorded and ACK matches it in `returnedReceiptEvidence`; receipt admission
  does not automatically clear freshness gates, and Kiro credits are never
  spent by drafting or running this lane.
- No Claude Code fallback. The Base44 repo's lane (referenced in the
  recommendation) retains it; Joe retired it and this repo does not copy it.
- Local demo limits stand: unauthenticated console, dry-run effects. Review
  feedback does not authorize unapproved production hardening.
