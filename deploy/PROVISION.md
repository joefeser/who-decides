# Provisioning the public who-decides demo

Numbered steps for a single EC2 host running the console behind Caddy with
automatic HTTPS. Placeholders (`<...>`) are filled in on the host only —
**no secret ever belongs in this repository**.

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

The unit runs `npm run console` (Next.js on `localhost:3100`) as
`who-decides`, and restarts it automatically on failure.

## 8. Install Caddy with the rate-limit module

The `rate_limit` directive needs `mholt/caddy-ratelimit`, so build Caddy
with xcaddy (Go required: `sudo apt-get install -y golang git`):

```bash
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy
sudo apt-get install -y golang git
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
sudo systemctl reload caddy   # or: sudo systemctl enable --now caddy
```

Caddy obtains the certificate on first start (watch
`sudo journalctl -u caddy -f`) and fronts the console with HSTS,
`X-Content-Type-Options: nosniff`, `Referrer-Policy:
strict-origin-when-cross-origin`, and a 30 req/min per-IP zone on `/api/*`.

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
