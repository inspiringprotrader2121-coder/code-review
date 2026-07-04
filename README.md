# Orvex Review

Self-hosted GitHub App that reviews PRs on **Velatrixcloud/Velatrix-Cloud** with deterministic rules first, LLM second, and intelligent re-review on push.

**Service repo:** [Velatrixcloud/code-review](https://github.com/Velatrixcloud/code-review)

## Features (Phase 1–3)

| Phase | Capability |
|-------|------------|
| **1** | Webhook → queue → diff → LLM → PR comment |
| **2** | SQLite state, fingerprints, incremental diff, “fixed on sha” replies |
| **3** | Inline P1/P2 comments, `.orvex-review.yml`, doc-audit + Semgrep, check runs |

## Prerequisites

1. **GitHub App** `Orvex Review` on Velatrixcloud org
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

## PR commands & auto-fix

Anyone with write access can drive Orvex from PR comments (trigger word
configurable via `ORVEX_TRIGGER`, default `@orvex`):

| Command | Where | Effect |
|---------|-------|--------|
| `@orvex review` | PR comment | Re-run the review on the current head |
| `@orvex fix` | PR comment | Commit all of Orvex's ready fix suggestions |
| `@orvex fix all` | PR comment | Ready fixes + AI-generate fixes for remaining findings |
| `@orvex fix this` | reply on a finding | Fix just that finding |
| `@orvex <instructions>` | reply on a finding | AI fix following your instructions |
| `@orvex explain` | reply on a finding | Deep-dive explanation of the issue |
| `@orvex ignore` | reply on a finding | Suppress this finding permanently for the repo |
| `@orvex auto-apply on/off` | PR comment | Auto-commit ready fixes after every future review of this PR (Orvex's findings only) |
| `@orvex help` | anywhere | Show the command list |

Each inline finding also carries:

- a native GitHub **```suggestion** block — GitHub shows the exact diff and its
  own *Commit suggestion* button per issue (and batching for several at once)
- an **`Apply fix` checkbox** — tick it and Orvex commits that one fix, then
  replies `✅ Fix applied in <sha>` and marks the checkbox done

**Safety:** fixes are only committed when the PR branch head hasn't moved since
the command, the exact target code still exists at HEAD, and no other Orvex fix
is running on the PR (per-PR lock). Concurrent edits abort the fix instead of
overwriting. Fork PRs are never pushed to — use the native suggestion buttons.

**GitHub App requirements:** `Contents: Read & write` permission, plus the
**Issue comment** and **Pull request review comment** event subscriptions.

## Per-repo config

Copy `examples/orvex-review.yml` to **Velatrix-Cloud** as `.orvex-review.yml`:

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
- `CHECK_RUNS_ENABLED=1` — GitHub check `orvex-review`
- `SEMGREP_DISABLED=1` — skip Semgrep layer
