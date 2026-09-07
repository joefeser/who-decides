# agentcore/ — AgentCore Runtime deploy config (AC-4)

Scaffold that points the AWS `agentcore` CLI at the AC-1 agent service
(`src/agent-service/server.ts`) for AgentCore Runtime deployment. The deploy
shape was locked in `docs/spike-log.md` (Day 7 addendum): Strands live-loop
agent on AgentCore Runtime, HTTP protocol, CodeZip build, short sessions;
the decision-authority API stays on the console's own HTTPS host; durable
state lives in our store via the decision API, never inside the runtime.

## What each file does

| File | Purpose |
| --- | --- |
| `agentcore.json` | Main project config: declares the `who_decides_agent` runtime (CodeZip, NODE_22, HTTP protocol, 600s idle timeout, `/mnt/data` sessionStorage, non-secret env vars). Schema-validated by the CLI. |
| `aws-targets.json` | Deployment targets (account + region). The account is a **placeholder** (`000000000000`) — the schema requires exactly 12 digits, and JSON has no comments, so the "replace me" note lives in the target's `description` field. Replace before any deploy. |
| `.env.local.example` | Template for `.env.local` (gitignored) listing every env var the agent service reads (`server.ts`, `machine-auth.ts`, `provider.ts`). No secrets, ever. |
| `app/who-decides-agent/main.ts` | CodeZip entry point. The CLI's Node packager bundles exactly `<codeLocation>/main.ts` with esbuild into a single CJS `main.js` (verified in `@aws/agentcore` 0.28.1, `dist/lib/packaging/node.js` — the filename is hard-coded). The glue imports the exported server from `src/agent-service/server.ts` and listens on `0.0.0.0:8080` if the module's own direct-run guard has not already started it. |

Why `agentcore/app/…` and not the CLI's default `app/…`: the repo root `app/`
is the Next.js App Router directory; nesting under `agentcore/` keeps Next
routing untouched and all deploy artefacts in one place.

## Field-name provenance (no guessed names)

Field names were verified against the CLI's own zod schemas
(`@aws/agentcore@0.28.1`: `dist/schema/schemas/agent-env.js`,
`agentcore-project.js`, `aws-targets.js`) and the pinned AWS docs:

- https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-get-started-cli.html
  — project layout (`agentcore/agentcore.json`, `agentcore/aws-targets.json`,
  `agentcore/.env.local`), CLI install (`npm install -g @aws/agentcore`,
  Node ≥ 20), CodeZip default build.
- https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-service-contract.html
  and …/runtime-http-protocol-contract.html — HTTP protocol: host `0.0.0.0`,
  port `8080`, `POST /invocations`, `GET /ping`.

Deviations from the task-packet shorthand, resolved by evidence (stop
conditions require citing, not guessing):

| Packet said | Reality (verified) |
| --- | --- |
| `serverProtocol` | The field is `protocol` (`ProtocolModeSchema`: `HTTP` \| `MCP` \| `A2A` \| `AGUI`). |
| `entryPoint` | The field is `entrypoint` (`EntrypointSchema`: `.ts/.js/.py` path). The actual bundled file must be named `main.ts`. |
| port 8080 as config | There is no port config field; 8080 is fixed by the HTTP protocol contract. We pin `WD_AGENT_PORT=8080` via `envVars` so the service agrees with the platform. |
| "microVM compute type" as config | There is no compute field: the Runtime **is** microVM compute (spike-log Day 7). What is configurable is the lifecycle: `lifecycleConfiguration.idleRuntimeSessionTimeout` (60–28800s; API default 900). |
| Strands framework in config | No framework field exists in the runtime spec. Strands is expressed by the code itself (`@strands-agents/sdk` dependency used by `src/agent-core/`) and `runtimeVersion: NODE_22`. |
| `agentcore build` | CLI 0.28.1 has no standalone `build` command; packaging happens inside `agentcore deploy`. Local, credential-free shape validation is `agentcore validate`. |
| comment in each JSON file | JSON forbids comments; citations live in the schema-sanctioned `description` fields (agent + target) and in this README. |

## Deploy command sequence (MANUAL — Joe, AC-5)

CI never makes AWS calls. All AWS-touching steps are human-run:

```bash
npm install                      # installs @aws/agentcore (devDependency)
npx agentcore validate           # config-shape validation; no AWS creds needed
npx agentcore deploy --dry-run   # preview CDK changes (needs AWS creds)
npx agentcore deploy             # CodeZip package -> S3, CDK provision, runtime endpoint
npx agentcore status             # get the runtime ARN (feeds WD_AGENTCORE_ENDPOINT, AC-3)
```

First deploy bootstraps CDK in the target account and takes a few minutes.
`agentcore/.env.local` is gitignored (repo-wide `.env.*` rule) — copy it from
`.env.local.example` for local runs; secrets for the deployed runtime
(`WD_API_KEY` if the openai-compatible escape hatch is ever used,
`WD_MACHINE_TOKEN_HASH`) must be injected through a mechanism approved at
deploy (AgentCore Identity or deploy-time env), never through git.

## Known residual risks for AC-5 (evidence-backed, not fixed here)

`src/agent-service/` and `src/agent-core/` are frozen in AC-4 scope, so these
are recorded, not patched:

1. **`/ping` body shape.** The HTTP contract documents `{"status": "Healthy"}`
   (or `HealthyBusy`) as the ping response; the AC-1 service returns
   `{ok: true, service: …, dataDir: …}` with HTTP 200. Endpoints, port, and
   status code match; the body schema may need a small service change before
   the first real deploy if the platform validates the body.
2. **esbuild bundling of native deps.** The Node CodeZip packager bundles the
   entry graph into one `main.js` with no external-deps mechanism, and
   `src/consumption/store.ts` imports `better-sqlite3` (a native `.node`
   addon). Deploy-time packaging may fail until the claim-DB access is
   externalized or restructured.
3. **CWD-relative fixture load.** `server.ts` reads
   `fixtures/patch-scenario.json` relative to the process CWD at module
   import; the CodeZip zip contains only the bundle (`main.js` +
   `package.json`), so a deployed boot would need the fixture path to become
   env-overridable or lazily loaded.
4. **Account placeholder.** `aws-targets.json` account `000000000000` passes
   the schema regex but MUST be replaced before `deploy`; the target
   `description` carries the warning.

Each is a small, well-scoped follow-up once AC-5 starts the real deploy.
