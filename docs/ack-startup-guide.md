# ACK startup guide — who-decides (proposal)

This guide accompanies the proposed lane at `.agent-control/lanes/pr-review-loop.yaml`.
**Neither is active policy until Joe merges the proposal PR, `onboard doctor
--base main` passes, and the lane's `status: draft` is flipped.** Source
recommendation: `docs/ack-onboarding-recommendation.md` on
`origin/codex/ack-main-only-onboarding` @ `c9656c4`.

## Verified environment (2026-09-04)

- CLI: `agent-control` 0.5.0, channel **stable** (`/opt/homebrew/bin/agent-control`,
  `agent-control version --json` reports `distFresh: true`, no source build).
- `onboard doctor --repo joefeser/who-decides --base main --json` runs clean and
  currently reports `onboarding_doctor_attention_required` — the lane file does
  not exist on main yet, which is the expected pre-proposal state.
- **Always pass `--base main`.** Several ACK defaults assume a `dev` base; this
  repo is main-only (feature branches → PRs → main, no `dev`).
- Reviewers confirmed installed on this repo: **codex** (chatgpt-codex connector,
  `@codex review` dispatch) and **qodo** (initial review on PR open). Sourcery is
  installed but deliberately disabled in the proposed lane.

## Startup commands (stable v0.5.0 — all verified present)

```sh
agent-control onboard doctor  --repo joefeser/who-decides --base main --json
agent-control onboard explain --repo joefeser/who-decides --base main --json
agent-control onboard worker-prompt --repo joefeser/who-decides --base main
```

Per-loop handoff (after implementation, on a PR):

```sh
agent-control pr-loop --repo joefeser/who-decides --pr NUMBER --base main \
  --require-codex-review --quiet --json --handoff-out <path>
```

`--compact` and `--json-decision` are v0.5.1 dev features, **not** in stable
v0.5.0 — check `--help` before using flags this guide does not list. Do not
rebuild ACK dev and treat it as stable.

## What the proposed lane says (reconciled from the generator draft)

- **Branch model:** main_only. Merge method `merge_commit`, never squash; main
  is human-mediated; owner-override auto-merge disabled.
- **Reviewers:** codex + qodo, both required, batched — no patch authority
  before `REQUIRED_REVIEW_BATCH_SETTLED`. Qodo gets its initial return only
  (no automatic re-tags on later heads); Codex re-requests are policy-gated
  with a 2-request ceiling. Manual bot retags are forbidden.
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
  **Do not use `npm test` — it is still the failing placeholder** (`package.json`
  on main). Fixing it is a separate small PR Joe can approve.

## Boundaries carried from the recommendation

- Kiro reviews are advisory-only unless an owner-admitted exact-head receipt is
  recorded and ACK matches it in `returnedReceiptEvidence`; receipt admission
  does not automatically clear freshness gates, and Kiro credits are never
  spent by drafting or running this lane.
- No Claude Code fallback. The Base44 repo's lane (referenced in the
  recommendation) retains it; Joe retired it and this repo does not copy it.
- Local demo limits stand: unauthenticated console, dry-run effects. Review
  feedback does not authorize unapproved production hardening.
