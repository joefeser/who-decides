# Provisioning the public who-decides demo

Numbered steps 1–10 provision a single EC2 host running the console behind
Caddy with automatic HTTPS. Step 11 wires that console to the deployed
AgentCore agent runtime (live mode). Placeholders (`<...>`) are filled in
on the host only — **no secret ever belongs in this repository**.

Target topology:

```
internet ── :443 Caddy (auto HTTPS, headers, rate limit)
                    └── reverse_proxy localhost:3100 (Next.js console, systemd)
```

## 1. Launch the EC2 instance

- AMI: Ubuntu 24.04 LTS (amd64), type `t3.micro`.
- Security group: allow **80/tcp** and **443/tcp** from `0.0.0.0/0`;
  restrict **22/tcp** to the administrator's IP. Nothing else.
- Associate an Elastic IP so the DNS record survives restarts.

## 2. Point DNS at the host

Create an A record for the demo domain (e.g. `demo.example.com`) → the
Elastic IP. Caddy obtains certificates on first start; DNS must resolve
before step 9.

## 3. Install Node 22

```bash
ssh -i <key.pem> ubuntu@<elastic-ip>
sudo apt-get update && sudo apt-get -y upgrade
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version   # expect v22.x
```

## 4. Create the service user and clone the repo

```bash
sudo useradd --system --create-home --shell /bin/bash who-decides
sudo git clone https://github.com/joefeser/who-decides.git /opt/who-decides
sudo chown -R who-decides:who-decides /opt/who-decides
```

## 5. Install dependencies and build the console

```bash
cd /opt/who-decides
sudo -u who-decides npm ci
sudo -u who-decides npm run console:build
```

## 6. Write the environment file

Create `/etc/who-decides.env`. systemd reads it as root before dropping
privileges, so `0600 root:root` is correct and the `who-decides` user never
reads it directly:

```bash
sudo install -m 0600 -o root -g root /dev/null /etc/who-decides.env
sudoedit /etc/who-decides.env
```

Contents — every `WD_*` variable the deployment consumes, with generation
commands. **Values below are placeholders; fill them in on the host only.**

```bash
# --- Operator gate (REQUIRED for the public demo) -------------------------
# sha256 hex of the operator passcode. Generate it, then paste the hash:
#   printf '%s' '<choose-a-long-passcode>' | sha256sum       # Linux
#   printf '%s' '<choose-a-long-passcode>' | shasum -a 256   # macOS
WD_OPERATOR_PASSCODE_HASH=<64-hex sha256 of the operator passcode>
# Agent dispatch (live mode — set BOTH, or neither):
# WD_AGENTCORE_ENDPOINT=<runtime ARN>
# WD_MACHINE_TOKEN=<the agent runtime's service token>
# Setting only one is an error: the console fails closed with
# ENVIRONMENT_BLOCKED instead of silently picking a mode.

# --- Console storage ------------------------------------------------------
# Data directory for the SQLite stores (state.db with runs + operator
# sessions, consumption.db with the claim ledger). Must be writable by the
# service user.
WD_CONSOLE_DIR=/opt/who-decides/.tmp/console

# One console instance serves one tenant; keep the default unless running
# deliberately multi-tenant (one process per tenant pool).
WD_TENANT_ID=default

# --- Provider configuration (OPTIONAL on this host) -----------------------
# The web console demo itself is deterministic (fixtures/patch-scenario.json)
# and does NOT call a model. Set these only if the same host also runs the
# live-loop / gate tooling (npm run live-loop, npm run gate:bedrock):
# Bedrock is the documented default; credentials come from the AWS default
# chain — on EC2, attach an instance role instead of storing keys.
#WD_BEDROCK_MODEL=<model-id>
#WD_AWS_REGION=<region>
# Escape hatch (tested fallback): any OpenAI-compatible endpoint.
#WD_PROVIDER=openai-compatible
#WD_BASE_URL=https://api.openai.com/v1
#WD_MODEL=gpt-4o
#WD_API_KEY=sk-...
```

`WD_GATE_*`, `WD_LIVE_*`, `WD_PROOF_*`, `WD_SCENARIO*`, `WD_TEST_CRASH` are
test-harness/internal variables — they are not part of a console deployment
and must not appear in `/etc/who-decides.env`.

Lock the file down:

```bash
sudo chmod 0600 /etc/who-decides.env
sudo mkdir -p /opt/who-decides/.tmp/console
sudo chown who-decides:who-decides /opt/who-decides/.tmp/console
```

## 7. Install and start the systemd service

```bash
sudo cp /opt/who-decides/deploy/who-decides.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now who-decides
systemctl status who-decides --no-pager
```

The unit runs `npm run console:start` (`next start -p 3100` serving the
production build from step 5) as `who-decides`, and restarts it
automatically on failure. (`npm run console` remains the local development
server and is not used on the public host.)

## 8. Install Caddy with the rate-limit module

The `rate_limit` directive needs `mholt/caddy-ratelimit`, so build Caddy
with xcaddy (Go required: `sudo apt-get install -y golang git`):

```bash
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy
sudo apt-get install -y golang git
# xcaddy is a separate executable from Caddy — install it before invoking it:
sudo env GOBIN=/usr/local/bin go install github.com/caddyserver/xcaddy/cmd/xcaddy@latest
xcaddy build --with github.com/mholt/caddy-ratelimit --output /tmp/caddy
sudo install -m 0755 /tmp/caddy /usr/bin/caddy
caddy list-modules | grep rate_limit   # expect http.handlers.rate_limit
```

## 9. Configure and start Caddy

```bash
sudo install -m 0644 /opt/who-decides/deploy/Caddyfile /etc/caddy/Caddyfile
# The Caddyfile reads the domain + ACME contact from the environment; add
# them to the Caddy service environment (separate from the app env file):
sudo systemctl edit caddy   # add:
#   [Service]
#   Environment=WD_DEMO_DOMAIN=demo.example.com
#   Environment=ACME_EMAIL=ops@example.com
# RESTART (not reload): the package install already started the stock Caddy
# daemon, and reloading does not replace a running binary — only a restart
# brings up the rate-limit-enabled build:
sudo systemctl restart caddy   # first install without a running service: sudo systemctl enable --now caddy
```

Caddy obtains the certificate on first start (watch
`sudo journalctl -u caddy -f`) and fronts the console with HSTS,
`X-Content-Type-Options: nosniff`, `Referrer-Policy:
strict-origin-when-cross-origin`, and two per-IP zones: `POST
/api/operator/login` at 10 req/min (second layer over the app's own
5-failures/15-min limit) and `/api/state` at 120 req/min for public
watch-mode polling. Mutations are operator-gated at the application and
are not Caddy-limited.

## 10. Health checks

```bash
# On the host: the console answers directly
curl -fsS http://localhost:3100/api/state          # JSON, "state":"ready" or live run

# Through Caddy over TLS
curl -fsS https://demo.example.com/api/state       # ..., "authenticated":false

# The gate: mutations are refused for visitors (expect 401)
curl -s -o /dev/null -w '%{response.code}\n' -X POST https://demo.example.com/api/run
# Login with the operator passcode (expect 200 + Set-Cookie), then mutations work:
curl -s -X POST https://demo.example.com/api/operator/login \
  -H 'content-type: application/json' \
  -d '{"passcode":"<the-passcode>"}' -c /tmp/wd-cookies.txt
curl -s -X POST https://demo.example.com/api/run -b /tmp/wd-cookies.txt
rm -f /tmp/wd-cookies.txt
```

Expected: `/api/state` always answers (watch mode stays public), every
mutation returns `401 {"ok":false,"error":"OPERATOR_AUTH_REQUIRED"}`
without a valid session cookie, and five failed logins trip the 15-minute
per-IP rate limit.

## 11. Live agent dispatch (AgentCore runtime, AC-6)

Steps 1–10 provision the console host. This section wires it to the real
agent runtime on AWS AgentCore. The console runs the deterministic fixture
demo only when **neither** live variable is set. Setting exactly one of
`WD_AGENTCORE_ENDPOINT` or `WD_MACHINE_TOKEN` is an invalid partial
configuration that fails closed with `ENVIRONMENT_BLOCKED`.

### Runtime deployment (manual — Joe's steps, Joe's authorization)

The runtime is a separate deployment from this host; the runbook is
[`agentcore/DEPLOY-CHECKLIST.md`](../agentcore/DEPLOY-CHECKLIST.md) and the
packaging rationale is [`agentcore/README.md`](../agentcore/README.md).
Current shape: a **Linux ARM64 Node 22 container** (`Dockerfile` at the
repo root, the container build context)
carrying the native `better-sqlite3` addon, HTTP protocol on 8080, with
run state on the `/mnt/data` session mount.

Deployment history, stated precisely:

- *Local experiments* (Bedrock gate, live-loop passes, 2026-09-03/04)
  ran real models on a laptop — they never exercised a deployed runtime.
- *Deployed revision* 2026-09-07 22:12 UTC: the runtime deployed as a
  CodeZip ("deploy complete" proved packaging only). The first real
  invoke timed out; CloudWatch showed two boot crashes behind it
  (missing schema files; the native SQLite addon could not ship in the
  CodeZip at all).
- *Verified outcome so far*: Codex's repair (8056d0b) repackages the
  agent as a container and passes the local gates — tests, Next build,
  `agentcore validate`, and an ARM64 container smoke that boots the image
  and loads native SQLite. **The repaired image is not yet deployed.**
  The deployment record on file predates the repair, and a READY status
  in the AWS console would not prove the runtime contains this code.
  Until a post-repair deploy is followed by a verified live cycle
  (AC-6), treat the runtime as unverified.

### Token setup

One machine service token, two derived configurations — the token itself
never lands in git or in this file:

- Mint it once, on the host or locally, and keep it in a password manager:
  `openssl rand -hex 32`. Its SHA-256 is what the runtime checks.

- Console host (this host): `WD_MACHINE_TOKEN=<token>` in
  `/etc/who-decides.env` (step 6).
- Agent runtime: `WD_MACHINE_TOKEN_HASH=<sha256(token)>`, validated
  timing-safely by the agent service. The tracked runtime config
  (`agentcore/agentcore.json`) commits only non-secret env vars, so the
  hash is installed **post-deploy via a control-plane patch**
  (`aws bedrock-agentcore-control update-agent-runtime
  --environment-variables ...`) — decided by Joe on 2026-09-08; the exact
  command lives in
  [`agentcore/DEPLOY-CHECKLIST.md`](../agentcore/DEPLOY-CHECKLIST.md).
  Because a later tracked-config deploy re-applies the env vars without
  the hash, **the patch must be re-applied and re-verified after every
  deploy**; until it is in place, every live invocation fails closed
  with `MACHINE_AUTH_DISABLED`.
- Regenerating the token requires updating both sides; a mismatch fails
  closed with 401, never open.

### Endpoint wiring and the live gate

- `WD_AGENTCORE_ENDPOINT` is the runtime **ARN**
  (`arn:aws:bedrock-agentcore:us-east-1:...:runtime/...`), captured from
  the deployment — `npx agentcore status` prints it, and
  `npx agentcore status --runtime-id <id>` works even where the local
  CLI state file was lost.
- Set BOTH `WD_AGENTCORE_ENDPOINT` and `WD_MACHINE_TOKEN`, then restart
  the console (step 7). Partial configuration fails closed.
- The live gate is
  `WD_AGENTCORE_ENDPOINT=... WD_MACHINE_TOKEN=... npm run test:agentcore-live`
  run from the repo. It skips with a stated reason when no endpoint is
  configured, and FAILS on missing token, credential, permission,
  transport, or malformed-response problems. It passes only on a real
  run → human decision → resume cycle with bound decision/receipt
  evidence. A skip is "not verified", not a pass.

### Mode switching is explicit, never a silent fallback

There is no safe-automatic rollback to deterministic mode: **deleting or
breaking the runtime does not fall back cleanly — configured live runs
surface the failure** (a failed dispatch keeps the run blocked with its
dispatch error; it does not advance to completion by timer or retry).
To deliberately run new runs in deterministic mode, unset BOTH live
variables and restart the console; that is an explicit configuration
choice for new runs, and existing runs keep the execution mode they
started under. If a live resume's outcome is uncertain, inspect the run
and the runtime logs before touching anything — there is no automatic
claim takeover or reexecution.
