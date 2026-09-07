# AC-5 deploy checklist (Joe, manual)

CI never calls AWS — everything below is a human step. Do item 1 **before**
any `agentcore` command that touches AWS. Full deploy background:
[`README.md`](./README.md).

## 1. Replace the placeholder account ID

- File: `agentcore/aws-targets.json`
- Field path: `[0].account` (the `who-decides-dev` target entry)
- Current value: `"000000000000"` (placeholder; passes the 12-digit schema regex)
- Set it to: **`"937830454526"`**

While you're there, optionally tidy `[0].description` to drop the
`REPLACE_BEFORE_DEPLOY` warning once the real ID is in.

Then validate the shape (no AWS credentials needed):

```bash
npx agentcore validate
```

## 2. Deploy sequence

```bash
npm install                      # installs @aws/agentcore (devDependency)
npx agentcore validate           # config-shape validation; no AWS creds needed
npx agentcore deploy --dry-run   # preview CDK changes (needs AWS creds)
npx agentcore deploy             # CodeZip package -> S3, CDK provision, runtime endpoint
npx agentcore status             # get the runtime ARN (feeds WD_AGENTCORE_ENDPOINT, AC-3)
```

First deploy bootstraps CDK in the target account and takes a few minutes.

## 3. Known blockers to expect at deploy time (read before deploying)

Per the README residual-risk section (evidence-backed as of this branch):

- **Packaging currently fails** on the unresolved optional peer
  `@aws-sdk/client-s3` (imported by `@strands-agents/sdk`'s context-offloader,
  unused by us). Decide the remedy — install the dependency or switch to
  Container build — before spending session time on IAM.
- **`better-sqlite3` cannot ship in a CodeZip** (native binary is not in the
  bundle; the CLI has no externals field). Container build is the fallback.
