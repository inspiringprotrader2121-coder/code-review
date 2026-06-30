# Velatrix Review

Self-hosted GitHub App that reviews PRs on **Velatrixcloud/Velatrix-Cloud** with LLM + Velatrix-specific rules.

**Service repo:** [Velatrixcloud/code-review](https://github.com/Velatrixcloud/code-review)

Phase 1: webhook → queue → diff → LLM → one PR comment.

## Prerequisites

1. **GitHub App** named `Velatrix Review` on the Velatrixcloud org
   - Permissions: `pull_requests` read/write, `contents` read, `metadata` read
   - Events: `pull_request`
   - Install on org; restrict to `Velatrixcloud/Velatrix-Cloud` initially
2. **Anthropic API key**
3. Node 20+, pnpm 9+

## Setup

```bash
cp .env.example .env
# Fill GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY_PATH, GITHUB_WEBHOOK_SECRET, ANTHROPIC_API_KEY

pnpm install
pnpm dev
```

Expose webhook (local dev):

```bash
ngrok http 8787
# Set GitHub App webhook URL → https://<ngrok>/webhooks/github
```

## Manual review (no webhook)

```bash
# Enqueue + worker (server must be running, or use --sync)
pnpm review --pr 67

# Inline — posts comment immediately
pnpm review --pr 67 --sync
```

Or HTTP:

```bash
curl -X POST http://localhost:8787/review \
  -H 'Content-Type: application/json' \
  -d '{"repoSlug":"Velatrixcloud/Velatrix-Cloud","pr":67}'
```

## Architecture

```
apps/server     Hono webhook + embedded worker loop
packages/github GitHub App auth, diff, comments
packages/review LLM + redaction + comment formatting
packages/queue  Idempotency + per-PR coalescing (memory or Redis)
rules/          Velatrix system prompt
```

## Phase 1 exit checklist

- [ ] Webhook fires on PR open/sync; worker logs job
- [ ] `pnpm review --pr N --sync` posts markdown findings
- [ ] Draft + Dependabot + self-authored PRs skipped
- [ ] Duplicate webhooks deduped by `(repo, pr, head_sha)`

## Env reference

See `.env.example`.

| Variable | Purpose |
|----------|---------|
| `GITHUB_APP_ID` | App ID |
| `GITHUB_APP_PRIVATE_KEY_PATH` | PEM path |
| `GITHUB_WEBHOOK_SECRET` | Webhook HMAC secret |
| `GITHUB_APP_BOT_LOGIN` | Skip self-authored PRs |
| `GITHUB_ALLOWED_REPO` | Allowlist `owner/repo` |
| `ANTHROPIC_API_KEY` | LLM |
| `QUEUE_BACKEND` | `memory` (default) or `redis` |
