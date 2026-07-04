# Velatrix Review

Self-hosted GitHub App that reviews PRs on **Velatrixcloud/Velatrix-Cloud** with deterministic rules first, LLM second, and intelligent re-review on push.

**Service repo:** [Velatrixcloud/code-review](https://github.com/Velatrixcloud/code-review)

## Features (Phase 1–3)

| Phase | Capability |
|-------|------------|
| **1** | Webhook → queue → diff → LLM → PR comment |
| **2** | SQLite state, fingerprints, incremental diff, “fixed on sha” replies |
| **3** | Inline P1/P2 comments, `.velatrix-review.yml`, doc-audit + Semgrep, check runs |

## Prerequisites

1. **GitHub App** `Velatrix Review` on Velatrixcloud org
   - Permissions: `pull_requests` R/W, `contents` R, `metadata` R, `checks` W (optional)
   - Events: `pull_request`
2. **MiniMax API key**
3. Node 20+, pnpm 9+
4. Optional: `semgrep` CLI on PATH for deterministic scans

## Setup

```bash
cp .env.example .env
# GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY_PATH, GITHUB_WEBHOOK_SECRET, MINIMAX_API_KEY

pnpm install
pnpm dev
```

## Manual review

```bash
pnpm review --pr 67 --sync
```

## Per-repo config

Copy `examples/velatrix-review.yml` to **Velatrix-Cloud** as `.velatrix-review.yml`:

```yaml
mode: normal
max_comments: 8
ignore:
  - "**/dist/**"
ignore_labels:
  - review-bot:ignore
```

## Architecture

```
apps/server/src/pipeline.ts   Full review orchestration
packages/store                SQLite PR state + findings
packages/rules                doc-audit, Semgrep, config
packages/review               LLM, fingerprints, merge, format
packages/github               API client (diff, reviews, checks)
packages/queue                Webhook job queue
```

## Quick start dashboard

1. Run the service (`pnpm dev`).
2. Open `http://localhost:8787/dashboard`.
3. Enter your workspace slug and connect the GitHub App.
4. Copy your PR and installation is then available through the status endpoint or manual `/review` commands.

You can also trigger review from a PR comment with `/review` or `@velatrix-review review`.

## Re-review behavior

On `synchronize`:

1. Diff only `last_sha..head_sha`
2. Re-run doc-audit / Semgrep / LLM on new hunks
3. Verify prior findings on HEAD (audit rules)
4. Reply `✅ Fixed on abc123` on resolved inline comments
5. Post only **new** fingerprints (no spam)

State persists in `.data/reviews.db` (or `STORE_PATH`).

## Scripts

| Command | Description |
|---------|-------------|
| `pnpm dev` | Webhook + worker |
| `pnpm review --pr N --sync` | One-shot review |
| `pnpm typecheck` | TypeScript |
| `pnpm test` | Unit tests |

## Env

See `.env.example` for full list. Key vars:

- `STORE_PATH` — SQLite database
- `CHECK_RUNS_ENABLED=1` — GitHub check `velatrix-review`
- `SEMGREP_DISABLED=1` — skip Semgrep layer
