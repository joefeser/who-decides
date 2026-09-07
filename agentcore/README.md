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
| `aws-targets.json` | Deployment targets (account + region). The account is a **placeholder** (`000000000000`) — the schema requires exactly 12 digits, and JSON has no comments, so the `REPLACE_BEFORE_DEPLOY` note lives in the target's `description` field. The exact field path, the real value, and the validation step are in [`DEPLOY-CHECKLIST.md`](./DEPLOY-CHECKLIST.md). Replace before any deploy. |
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

## Known residual risks for AC-5 (evidence-backed)

Status after the AC-5-prerequisites branch (ping contract + fixture bundling +
native-addon strategy). Every claim below was verified against the pinned CLI
(`@aws/agentcore@0.28.1`) in `node_modules/@aws/agentcore`, not guessed.

1. **FIXED — `/ping` body shape.** The service now returns
   `{"status":"Healthy","service":…,"dataDir":…}` per the runtime HTTP
   protocol contract; asserted in `src/agent-service/test.ts`.

2. **BLOCKER — CodeZip packaging fails today: `@aws-sdk/client-s3` cannot
   resolve.** Replaying the packager's exact esbuild invocation on
   `agentcore/app/who-decides-agent/main.ts` errors with
   `Could not resolve "@aws-sdk/client-s3"`: `@strands-agents/sdk`'s vended
   context-offloader does `await import('@aws-sdk/client-s3')`
   (`dist/src/vended-plugins/context-offloader/storage.js:298`), it is an
   *optional peer* of the SDK, and it is not installed — esbuild fails the
   whole bundle on the unresolvable specifier even though we never use
   context offloading. This fires during the packaging step of
   `agentcore deploy`, before any AWS API call. Decision needed before AC-5
   (packet stop condition: document, don't improvise):
   - install `@aws-sdk/client-s3` so the specifier resolves (simplest; the
     unused S3 client inlines into the bundle, size cost only), or
   - Container build (same escape hatch as risk 3).
   Repro: `npx esbuild agentcore/app/who-decides-agent/main.ts --bundle
   --platform=node --format=cjs --minify --target=node22 --outfile=/tmp/main.js`

3. **DOCUMENTED — `better-sqlite3` native addon cannot ship in a CodeZip.**
   The packet asked for an `externals`/`external` field in `agentcore.json`.
   Verified against 0.28.1: **no such field exists.**
   - `dist/schema/schemas/agentcore-project.js` — the only "external" hits
     are comments about external knowledge bases/evaluators.
   - `dist/lib/packaging/node.js` — both CodeZip packagers call esbuild with
     a fixed option set (`bundle/platform/format/minify/target/banner/define`):
     there is no config hook to add `external`.
   - Its only escape hatch, `copyDynamicDeps`, copies a **hard-coded** list
     (`ws`, `readable-stream`, `safe-buffer`, …) from
     `<codeLocation>/node_modules` into `_deps/` — `better-sqlite3` and `pg`
     are not on the list, and our repo has no `<codeLocation>/node_modules`.
   Behavior consequence (repro above): better-sqlite3's *JS* bundles fine
   (its binary path is built at runtime via `path.join(__dirname, …)`), but
   the zip contains only `main.js` + `package.json`, so the runtime
   `.node` resolution finds nothing and the store require throws at boot.
   `pg` is pure JavaScript and bundles without issue. The store seam already
   supports Postgres (`WD_STORE`), but restructuring the agent's claim-DB
   path was out of scope here: **Container build** (npm install inside a
   Linux image) is the documented fallback. No config change was made.

4. **OPEN — account placeholder (Joe, AC-5).** `aws-targets.json` account
   `000000000000` passes the schema regex but MUST be replaced before
   `deploy`. Exact field path and value: `agentcore/DEPLOY-CHECKLIST.md`;
   the target `description` carries the REPLACE_BEFORE_DEPLOY warning.
