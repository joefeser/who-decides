# AgentCore deployment

The runtime uses a Linux ARM64 Node 22 container. `agentcore/Dockerfile`
bundles application source and JSON schemas while keeping npm packages in
`node_modules`, including the native `better-sqlite3` binary installed inside
Linux. This preserves the existing consumption-store implementation.

`agentcore.json` selects `Container`, the repository root build context, port
8080, Bedrock, and the `/mnt/data` session-storage mount. `aws-targets.json`
contains the deployment account and region. An AWS account ID is an identifier,
not a credential. Do not replace the working target with a placeholder as a
security measure.

## Validate locally

Use Node 22 (`nvm use`; see `.nvmrc`), then:

```sh
npm ci
npx tsc --noEmit
npm test
npx agentcore validate
docker build --platform linux/arm64 -f agentcore/Dockerfile -t who-decides:ac5-repair .
npm run test:container
```

The container smoke test checks Node 22/ARM64, loads native SQLite, boots the
packaged service, calls `/ping`, and confirms missing machine authentication
fails closed. It makes no AWS or model calls. Docker must support ARM64
execution (native ARM64 or QEMU).

The entrypoint is `app/who-decides-agent/main.ts`; the Dockerfile produces
`dist/agent.cjs` and starts it explicitly. The old CodeZip CLI hard-coded
`main.ts`, omitted arbitrary files/native binaries, and attempted to resolve
an unused optional S3 import while bundling the whole SDK. Static JSON imports
solve missing schemas. External npm packages in the container solve the native
binary and unused optional-import packaging problems. AWS itself supports
correctly compiled native binaries in direct-code ZIPs; the old restriction
was in this CLI's bundle construction.

## Live deployment

Follow [DEPLOY-CHECKLIST.md](DEPLOY-CHECKLIST.md). Deployment success is not
proof of application startup or a successful A → decision → B cycle.

The machine token travels inside the invocation payload as `credential`.
Configure its SHA-256 hash as `WD_MACHINE_TOKEN_HASH` on the runtime through
an approved deployment-time mechanism. Configure the original token as
`WD_MACHINE_TOKEN` on the console host and the Runtime ARN as
`WD_AGENTCORE_ENDPOINT`. No credentials belong in tracked configuration.

The console stores each run's execution mode. Live runs advance only from
confirmed agent responses; timers advance deterministic demo runs only.
Failed live runs retain their dispatch result and do not produce completion
artifacts. An interrupted/uncertain live resume is not automatically retried.
Session storage is same-session runtime state, not a replacement for the
console's durable operator-decision record.

Sources: [AWS Node deployment](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-get-started-code-deploy-node.html),
[AWS account identifiers](https://docs.aws.amazon.com/accounts/latest/reference/manage-acct-identifiers.html),
and the installed `@aws/agentcore` 0.28.1 schema and build-context resolver.
