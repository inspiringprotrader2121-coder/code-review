# Orvex Review

Self-hosted AI code review for GitHub. Install the GitHub App, open a PR, and Orvex posts inline findings — with optional auto-fix, deep review, and billing for multi-tenant SaaS.

**License:** [MIT](./LICENSE)  
**Repos:** [Velatrixcloud/code-review](https://github.com/Velatrixcloud/code-review) · [inspiringprotrader2121-coder/code-review](https://github.com/inspiringprotrader2121-coder/code-review)

---

## What you get

| Capability               | Notes                                                              |
| ------------------------ | ------------------------------------------------------------------ |
| PR review on open / push | Diff + repo context → LLM → summary + inline comments              |
| Deterministic layers     | Optional Semgrep + config rules before the model                   |
| Re-review on push        | Fingerprints prior findings; replies when issues are fixed         |
| PR commands              | `@orvex review`, `deep`, `fix`, `explain`, `ignore`, `help`, …     |
| Auto-fix                 | Suggestion blocks + Apply checkbox; commits only with safety locks |
| Multi-tenant SaaS        | Installations, plans, Stripe overage, dashboards                   |
| Check runs               | Optional GitHub Check `orvex-review`                               |

---

## Requirements

- **Node.js 22.13+** and **pnpm 11.7.0** (via Corepack). CI and fresh-Linux
  verification use the exact Node version in [`.node-version`](./.node-version).
- A **GitHub App** (permissions below)
- **MiniMax and DeepSeek API keys** for normal review tracks
- **OpenAI API-key-authenticated Codex CLI home** when enabling Verify-tier Luna
- Redis (`QUEUE_BACKEND=redis`) for production; optional locally alongside
  Semgrep on `PATH` and Docker (runtime verification)

---

## Quick start (local)

```bash
git clone https://github.com/Velatrixcloud/code-review.git
cd code-review
corepack enable
pnpm install

cp .env.example .env
# Fill at least:
#   GITHUB_APP_ID
#   GITHUB_APP_PRIVATE_KEY_PATH=./orvex-review.pem   # download from the App settings
#   GITHUB_WEBHOOK_SECRET
#   REVIEW_API_SECRET=$(openssl rand -hex 32)
#   MINIMAX_API_KEY=...
#   ORVEX_DEEPSEEK_API_KEY=...
#   STORE_PATH=./.data/orvex-review.db
#   APP_URL=http://localhost:8787

pnpm typecheck
pnpm test
pnpm dev
```

Server listens on `HOST`/`PORT` (default `0.0.0.0:8787`).

Expose it for GitHub webhooks (e.g. ngrok):

```bash
ngrok http 8787
# Set APP_URL to the ngrok https URL
# Update the GitHub App webhook + setup URLs to the same host
```

Liveness: `GET /health`. Readiness (database, queue, drain, active jobs, and
Codex status): `GET /ready`.

---

## GitHub App setup

Create an app (org or user): [New GitHub App](https://github.com/settings/apps/new).

| Setting          | Value                                          |
| ---------------- | ---------------------------------------------- |
| Webhook URL      | `{APP_URL}/webhooks/github`                    |
| Webhook secret   | same as `GITHUB_WEBHOOK_SECRET`                |
| Setup / callback | see [docs/SAAS_SETUP.md](./docs/SAAS_SETUP.md) |

**Permissions:** Metadata (R), Contents (R/W), Pull requests (R/W), Issues (R/W), Checks (R/W optional).

**Events:** `pull_request`, `issue_comment`, `pull_request_review_comment`, `installation`, `installation_repositories`.

Download a private key → save as `orvex-review.pem` (gitignored) and point `GITHUB_APP_PRIVATE_KEY_PATH` at it.

Install the app on a test repo, open a PR, and you should see a review comment within a few minutes (model latency depends on tier).

More detail: **[docs/SAAS_SETUP.md](./docs/SAAS_SETUP.md)** · **[docs/HOW_IT_WORKS.md](./docs/HOW_IT_WORKS.md)**

---

## Manual one-shot review (CLI)

With the same `.env` as the server:

```bash
pnpm review --pr 67 --sync
# typically needs --owner OWNER --repo REPO (see CLI --help)
```

---

## PR commands

Trigger word defaults to `@orvex` (`ORVEX_TRIGGER`). Write access is required for mutating commands; `help` / public rate info may be restricted by plan.

| Command                               | Effect                                                       |
| ------------------------------------- | ------------------------------------------------------------ |
| `@orvex review`                       | Re-run review on current head                                |
| `@orvex deep`                         | Extra analysis (counts as more billable units on paid plans) |
| `@orvex fix` / `fix this` / `fix all` | Commit ready / AI fixes                                      |
| `@orvex explain`                      | Explain a finding (thread)                                   |
| `@orvex ignore`                       | Suppress a finding for the repo                              |
| `@orvex rate limit`                   | Quota status (collaborators)                                 |
| `@orvex help`                         | Command list                                                 |

Fixes only land when the branch head is unchanged, the target code still matches, and no other Orvex fix holds the PR lock. Fork PRs are never pushed.

---

## Per-repo config

Copy [examples/orvex-review.yml](./examples/orvex-review.yml) into a customer repo as `.orvex-review.yml`:

```yaml
mode: normal
max_comments: 8
ignore:
  - '**/dist/**'
ignore_labels:
  - review-bot:ignore
```

---

## Project layout

```
apps/server/     HTTP API, webhooks, worker pipeline
apps/cli/        One-shot review CLI
apps/eval/       Offline eval / benchmarks
packages/github  GitHub App client, diffs, archives
packages/review  LLM passes, verifier, formatting, Codex CLI
packages/store   SQLite tenants, runs, findings
packages/queue   Memory / Redis job queue
packages/rules   Config + Semgrep / audits
packages/tenants Plans, install binding, auth helpers
docs/            SaaS setup + how it works
scripts/         Deploy, backup, restore drill
```

---

## Scripts

| Command                    | Description                                           |
| -------------------------- | ----------------------------------------------------- |
| `pnpm dev`                 | API + worker (development)                            |
| `pnpm start`               | Production start for `@orvex-review/server`           |
| `pnpm build`               | Build all packages                                    |
| `pnpm typecheck`           | TypeScript across the workspace                       |
| `pnpm test`                | Unit tests (+ script tests)                           |
| `pnpm format:check`        | Formatting policy                                     |
| `pnpm check:dependencies`  | Workspace dependency policy                           |
| `pnpm check:docs`          | Generated configuration and local documentation links |
| `pnpm check:built-exports` | Compiled public API import smoke test                 |
| `pnpm coverage:report`     | Coverage measurement without changing a baseline      |
| `pnpm coverage:check`      | Enforce a reviewed coverage baseline                  |
| `pnpm review --pr N`       | CLI review                                            |
| `pnpm eval`                | Eval harness                                          |

---

## Environment

All variables are documented in **[.env.example](./.env.example)** and the generated **[configuration reference](./docs/CONFIGURATION.md)**. Minimum for a first review:

- `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_PATH`, `GITHUB_WEBHOOK_SECRET`
- `REVIEW_API_SECRET`
- `STORE_PATH` (SQLite path outside the repo in production)
- MiniMax and DeepSeek provider keys; high-tier Luna additionally requires the pinned Codex CLI API-key home
- `APP_URL` matching your public webhook host

Never commit `.env`, `*.pem`, or database files — they are gitignored.

---

## Production notes

- Keep `STORE_PATH` on durable disk **outside** the git checkout.
- Deploy only with `scripts/deploy-safe.sh --dry-run`, inspect its file list,
  then `scripts/deploy-safe.sh --restart`. Raw `rsync` is prohibited. The
  guarded release procedure and rollback conditions are in the
  [deployment runbook](./docs/DEPLOYMENT_RUNBOOK.md).
- API, worker, and scheduler process roles plus load-balancer traffic readiness
  are documented in the [fleet deployment guide](./docs/FLEET_DEPLOYMENT.md).
  Do not run a multi-host fleet until its Postgres and shared-admission gates
  are complete.
- Set `ORVEX_ADMIN_SECRET` for admin bearer automation (do not reuse `PLATFORM_SECRET`).
- Optional: Redis queue, Stripe keys, Codex CLI homes — see `.env.example`.

---

## License

[MIT](./LICENSE) © 2026 Orvex / Velatrixcloud
