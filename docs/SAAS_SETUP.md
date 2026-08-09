# SaaS setup — GitHub App (multi-tenant)

One **GitHub App** powers all customers. Each customer **installs** it on their org; you store `installation_id` per tenant.

## 1. Create the GitHub App

[Create new GitHub App](https://github.com/settings/apps/new) (under your **company** org, not a customer org).

| Field              | Value                                                                                    |
| ------------------ | ---------------------------------------------------------------------------------------- |
| **Name**           | Orvex Review                                                                             |
| **Homepage URL**   | Your marketing site or `APP_URL`                                                         |
| **Callback URL**   | Not used (leave default)                                                                 |
| **Setup URL**      | `{APP_URL}/auth/github/callback` e.g. `https://api.orvexreview.com/auth/github/callback` |
| **Webhook URL**    | `{APP_URL}/webhooks/github`                                                              |
| **Webhook secret** | Same as `GITHUB_WEBHOOK_SECRET` in `.env`                                                |
| **Active**         | Yes                                                                                      |

### Permissions

| Permission    | Access                                  |
| ------------- | --------------------------------------- |
| Metadata      | Read                                    |
| Contents      | Read & write (auto-fix commits)         |
| Pull requests | Read & write                            |
| Checks        | Read & write (optional, for check runs) |
| Issues        | Read & write (PR comments)              |

### Events (subscribe)

- [x] Pull request
- [x] Issue comment
- [x] Pull request review comment
- [x] Installation
- [x] Installation repositories

Uncheck everything else unless you need it.

### Where to get credentials

| Env var                       | GitHub App page                              |
| ----------------------------- | -------------------------------------------- |
| `GITHUB_APP_ID`               | **App ID** (top of settings)                 |
| `GITHUB_APP_PRIVATE_KEY_PATH` | **Generate a private key** → download `.pem` |
| `GITHUB_WEBHOOK_SECRET`       | **Webhook** → Secret                         |
| `GITHUB_APP_SLUG`             | URL slug: `github.com/apps/**orvex-review**` |
| `GITHUB_APP_BOT_LOGIN`        | After install: `orvex-review[bot]`           |

## 2. Platform `.env`

```bash
APP_URL=https://api.yourproduct.com   # must match Setup URL host
PLATFORM_SECRET=<openssl rand -hex 32>
GITHUB_APP_ID=...
GITHUB_APP_PRIVATE_KEY_PATH=./orvex-review.pem
GITHUB_WEBHOOK_SECRET=...
GITHUB_APP_SLUG=orvex-review
ANTHROPIC_API_KEY=...
STORE_PATH=./.data/orvex-review.db
```

Do **not** set `GITHUB_ALLOWED_REPO` in production SaaS (that’s legacy single-tenant dev only).

## 3. Customer connect flow

1. Customer opens `{APP_URL}/connect`
2. Enters workspace slug (e.g. `acme`)
3. Redirected to GitHub → picks org → selects repos
4. GitHub redirects to `/auth/github/callback?installation_id=…&state=…`
5. You store `tenant` + `installation_id` in SQLite/Postgres
6. PR webhooks include `installation.id` → reviews run scoped to that tenant

Verify: `GET {APP_URL}/api/tenants/acme`

## 4. Local dev with ngrok

```bash
ngrok http 8787
# Set APP_URL=https://xxxx.ngrok.io in .env
# Update GitHub App Setup URL + Webhook URL to ngrok host
pnpm dev
# Open https://xxxx.ngrok.io/connect
```

## 5. Selling the product

| You store (platform `.env`)         | Per customer (database)          |
| ----------------------------------- | -------------------------------- |
| App ID, private key, webhook secret | `tenant_id`, `installation_id`   |
| LLM API keys (or BYOK later)        | Workspace slug, settings         |
| `APP_URL`, `PLATFORM_SECRET`        | PR review state per installation |

Customers never paste GitHub passwords — they **authorize the App** with scoped permissions.

## 6. Production checklist

- [x] Redis-backed queue and user auth linked to `tenant_id`
- [x] Stripe billing per workspace with durable webhook deduplication
- [x] CI typecheck, test, and build gate
- [ ] Choose and test an off-site backup destination
- [ ] Configure external uptime/error alerting for `/health` and `/ready`

For the single production worker, keep the live database outside the checkout:

```bash
STORE_PATH=/home/orvex/orvex-data/velatrix-review.db
REDIS_URL=redis://...          # required in production
QUEUE_BACKEND=redis
```

Deploy only with `scripts/deploy-safe.sh --dry-run` followed by
`scripts/deploy-safe.sh --restart`. The deployment drains active reviews,
stages the release, runs the full fresh-Linux policy/typecheck/test/build/import
gate on the staged tree, and uses `ecosystem.config.cjs` so PM2 waits longer
than the configured drain window before killing the worker. See the
[deployment runbook](./DEPLOYMENT_RUNBOOK.md) for the release identifier,
rollback path, and required evidence.

The repository includes `scripts/backup-db.mjs`, which performs a consistent
SQLite backup, verifies integrity, keeps a bounded local retention window, and
optionally copies each backup to `ORVEX_BACKUP_REMOTE` with `rsync`. Schedule it
at least daily and verify a restore before launch; an off-site destination and
restore drill remain required operational inputs.
