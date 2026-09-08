# AC-5 deployment and AC-6 acceptance

Deployment is manual. Local checks do not modify AWS.

## Prerequisites

- Node 22, locked dependencies (`npm ci`), Docker with Linux ARM64 support.
- The installed CLI requires `uv` even for this Node application.
- Live AWS credentials and the intended account/region in `aws-targets.json`.
- Preserve `agentcore/.cli/`: its deployed-state record is not disposable
  build cache. Do not clean it during dependency or build troubleshooting.
- A reviewed mechanism to inject `WD_MACHINE_TOKEN_HASH` into runtime
  configuration without committing it. `.env.local` by itself does not prove
  a variable reaches the deployed runtime. **Decided 2026-09-08 (Joe):
  post-deploy control-plane patch** — see step 3 of "Deploy and verify".
  It must be re-applied after every `agentcore deploy` (step 4 below).

## Local artifact gate

```sh
npx tsc --noEmit
npm test
npm run scenario
npx agentcore validate
docker build --platform linux/arm64 -f Dockerfile -t who-decides:ac5-repair .
npm run test:container
```

The container gate must boot the image and load native SQLite, not merely
finish a build. See [README.md](README.md) for the packaging rationale.

## Deploy and verify

```sh
npx agentcore deploy --dry-run
npx agentcore deploy
npx agentcore status
```

Review the diff when moving from CodeZip to Container. Do not assume an
unchanged runtime ID, an empty diff, or in-place adoption. Record the actual
Runtime ARN and execution role returned by the deployment. A READY resource
alone is not proof of a working invocation.

The 2026-09-08 diff review (dry-run + `--diff`) confirmed the CodeZip →
Container move updates `AWS::BedrockAgentCore::Runtime` IN PLACE
(`CodeConfiguration` → `ContainerConfiguration`; runtime ID unchanged) and
otherwise only adds the image-build chain: ECR repository + KMS key, a
CodeBuild project, and a Lambda build trigger, with ECR pull / KMS-decrypt
grants for the execution role.

### Step 3: patch the machine-token hash (after EVERY deploy)

The tracked runtime config commits only non-secret env vars, so
`WD_MACHINE_TOKEN_HASH` is installed post-deploy via the control plane
(Joe's decision, 2026-09-08). Run with the hash in an env var so it never
lands in shell history:

```sh
read -s WD_HASH   # paste: printf '%s' "$TOKEN" | shasum -a 256 | cut -d' ' -f1
aws bedrock-agentcore-control update-agent-runtime \
  --agent-runtime-id whoDecides_who_decides_agent-1mF5fr45DG \
  --environment-variables WD_AGENT_PORT=8080,WD_AGENT_DATA_DIR=/mnt/data/agent,WD_PROVIDER=bedrock,WD_MACHINE_TOKEN_HASH="$WD_HASH" \
  --region us-east-1
```

Confirm the runtime ID first with `npx agentcore status` (it has been
stable across re-deploys, but verify, don't assume). Verify the patch by
re-reading `aws bedrock-agentcore-control get-agent-runtime` and checking
the hash KEY is present in `environmentVariables` — never print the value.
**Every subsequent `npx agentcore deploy` re-applies the tracked config
WITHOUT the hash**, silently re-enabling fail-closed
`MACHINE_AUTH_DISABLED` — re-run this patch and the check after each
deploy. If the update call rejects `--environment-variables`, stop and
check the current API shape instead of improvising.

Set `WD_AGENTCORE_ENDPOINT` to the Runtime ARN and `WD_MACHINE_TOKEN` on the
console host. Both must be supplied for live mode; partial configuration is
an error. Restart the console after configuration changes.

AC-6 remains open until live evidence proves all of:

1. A fresh session returns `DECISION_REQUIRED` with the expected scenario.
2. The recorded choice/rationale resumes that same session to `COMPLETED`.
3. An identical resume returns a duplicate without a new successor.
4. A conflicting choice/rationale is rejected.
5. Credential, startup, transport and unexpected typed errors fail the gate.
6. The console reflects the actual live result; a failed invocation does not
   advance to successful completion.

An env-gated test may skip when no endpoint is configured. A skip, TODO,
compiling test, or typed failure does not establish AC-6 completion.

## Recovery and deterministic mode

Do not delete the stack as an automatic rollback procedure. To deliberately
return the console to deterministic mode, unset BOTH live-dispatch variables,
restart the console, and start a new run. Existing runs retain their original
execution mode. Inspect any uncertain resume before taking further action;
there is no automatic claim takeover or reexecution.

If CLI deployment state is lost, reconcile the live stack through the CLI
and inspect its proposed diff. A raw CDK update does not reconstruct the CLI's
local deployed-state record. Preserve account targets and existing state.
