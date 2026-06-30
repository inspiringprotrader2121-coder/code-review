# Velatrix Review — build plan

Self-hosted GitHub App that reviews PRs on **Velatrixcloud/Velatrix-Cloud** (and other org repos) with deterministic rules first, LLM second, and intelligent re-review on push.

**Host repo:** [Velatrixcloud/code-review](https://github.com/Velatrixcloud/code-review) (private).

**Not in scope:** replacing CI, chat-with-codebase SaaS, multi-tenant product, or full-repo embeddings (until Phase 4).

**Related tooling (already exists):** `~/.cursor/skills/pr-review-bot-loop/` — today this **consumes** other bots’ comments (fix, verify on HEAD, resolve). Velatrix Review is the **producer**: it posts findings. Phase 2–3 ports verification and dedup patterns from that skill.

---

## What we’re building

| Piece | Description |
|-------|-------------|
| **GitHub App** | `Velatrix Review` — org install, webhook secret |
| **Triggers** | `pull_request`: `opened`, `synchronize`, `reopened` |
| **Skips** | Draft PRs, `dependabot[bot]`, PRs from the app bot itself (configurable) |
| **Pipeline** | diff → rules (doc-audit + Semgrep) → LLM → merge/cap → post review |
| **Re-push** | Incremental diff since `last_sha`, fingerprint dedup, acknowledge fixes |
| **Store** | `pr_number`, `last_sha`, `findings[]` in Postgres or KV |

### Review pipeline (target state)

```
Webhook (opened | synchronize | reopened)
  → enqueue job { owner, repo, pr, head_sha, action }
  → skip if draft / excluded author / app bot author / label review-bot:ignore
  → idempotency: skip if head_sha already reviewed (or job in-flight for same PR)
  → concurrency: at most one active review per (repo, pr) — coalesce rapid pushes
  → load .velatrix-review.yml (ignore paths, strict | normal)
  → fetch diff (head vs merge base; on sync: old_head..new_head)
  → deterministic: doc-audit-verify + Semgrep on changed paths
  → LLM: changed hunks only, Velatrix rules, structured JSON output
  → merge + dedup fingerprints + severity/confidence filter
  → cap at 8 comments (summary always; inline P1/P2 only)
  → POST .../pulls/{n}/reviews (summary + inline comments[])
  → on sync: reply “fixed on {sha}” / mark outdated where applicable
  → persist last_sha + findings[] + token spend
```

### Stack (recommended)

| Layer | Choice |
|-------|--------|
| HTTP / webhook | Cloudflare Worker **or** small Node (Hono/Fastify) |
| Queue | Redis list, Inngest, or Trigger.dev |
| State | Postgres (findings history) + KV (fast `last_sha` / fingerprints) |
| LLM | Anthropic (Sonnet review) + optional Haiku triage later |
| Rules | Port `doc-audit-verify.mjs`; Semgrep CI rules in repo |

**Cost ballpark:** ~$0.05–0.40/PR at 20–50 PRs/mo; hosting &lt;$20/mo.

---

## Phase 1 — “It works”

**Time:** 3–5 days  
**Goal:** Open a PR → bot posts one useful comment within ~1–2 min.

### Deliverables

1. **GitHub App registration**
   - Name: `Velatrix Review`
   - Permissions: `pull_requests: read/write`, `contents: read`, `metadata: read`
   - Events: `pull_request`
   - Org install on **Velatrixcloud**; restrict to **Velatrixcloud/Velatrix-Cloud** initially

2. **Webhook endpoint**
   - Verify `X-Hub-Signature-256`
   - Parse `pull_request` actions: `opened`, `synchronize`, `reopened`
   - Log: `pr_number`, `head_sha`, `repo`, `action`
   - Enqueue job (Redis / Inngest) — don’t review inline in webhook handler
   - **Idempotency:** dedupe jobs by `(repo, pr, head_sha)` so GitHub retries don’t double-review
   - **Concurrency:** if a review is in-flight for `(repo, pr)`, queue latest `head_sha` and run once when current job finishes (coalesce pushes)

3. **Manual trigger (dev)**
   - CLI or `POST /review` with `{ owner, repo, pr }` for local testing without webhook

4. **Diff fetch**
   - `GET /repos/{owner}/{repo}/pulls/{n}/files`
   - Patch diff per file (or unified diff from compare API)
   - Respect max file size; skip binary / generated paths (hardcoded list for now)

5. **LLM review (v0)**
   - System prompt: Velatrix rules (`RULES.md`, audit doc conventions, IPTV/security patterns)
   - User payload: changed files + hunks only
   - **Structured output** (JSON schema):
     ```json
     { "findings": [{ "file", "line", "severity", "category", "message", "suggestion", "confidence" }] }
     ```
   - Redact obvious secrets in diff before sending to LLM

6. **Post one PR comment**
   - Markdown summary table: severity | file | message
   - No inline comments yet
   - Skip draft PRs, `dependabot[bot]`, and PRs opened by the app’s own bot user (env flag)

### Repo layout (suggested)

```
code-review/
├── apps/
│   ├── webhook/          # Worker or Node entry
│   └── worker/           # job consumer
├── packages/
│   ├── github/           # App auth, diff fetch, comment post
│   ├── review/           # prompt, LLM client, finding merge
│   └── rules/            # doc-audit port, semgrep runner
├── plan.md
└── README.md
```

### Tickets

| # | Task | Notes |
|---|------|-------|
| 1.1 | Create GitHub App + store credentials | App ID, private key, webhook secret in env |
| 1.2 | Webhook route + signature verify | Return 200 fast; enqueue only |
| 1.3 | Job queue + worker skeleton | Log job payload; retry on failure |
| 1.4 | GitHub App installation token | JWT → installation access token |
| 1.5 | `fetchPrDiff(owner, repo, pr)` | Files + patches; truncate large files |
| 1.6 | `runLlmReview(diff, rules)` | Structured JSON; parse + validate schema |
| 1.7 | `postPrComment(summaryMd)` | Single issue comment on PR |
| 1.8 | Skip draft + dependabot + self | Config via env; skip `pull_request.user.login` matching app bot |
| 1.9 | `velatrix-review review --pr N` CLI | Manual dev trigger |
| 1.10 | Job idempotency key | `(owner, repo, pr, head_sha)` — ignore duplicate enqueue |
| 1.11 | Per-PR review lock | One in-flight review; coalesce `synchronize` bursts to latest `head_sha` |

### Exit criteria

- [ ] Webhook fires on PR open/sync; worker logs job
- [ ] Manual CLI reviews PR #N on Velatrixcloud/Velatrix-Cloud
- [ ] Bot posts markdown findings within ~2 min
- [ ] Draft PRs and Dependabot PRs skipped

### Known limitation

Re-push will re-post similar findings (noisy). Fixed in Phase 2.

---

## Phase 2 — “Re-review without spam”

**Time:** 3–5 days  
**Goal:** Push 3× on one PR → bot updates intelligently, not 3× the same nit.

**Hardest phase.** Most DIY bots stop at Phase 1.

### Deliverables

1. **Persist review state**
   - Table/KV: `(repo, pr_number) → { last_sha, findings[], posted_at }`
   - Each finding: `{ id, fingerprint, file, line, severity, category, message, github_comment_id? }`

2. **Finding fingerprint**
   - `hash(file + line + rule_id + normalized_message)`
   - `rule_id` from deterministic rules; LLM findings use `category + message stem`

3. **Incremental diff on `synchronize`**
   - Compare `last_sha..head_sha` (or merge-base strategy — document choice)
   - Re-run rules + LLM **only on files/hunks in new commit range**
   - Summary line: “3 new issues, 2 prior issues fixed on `abc123`”

4. **Dedup before post**
   - Don’t re-post fingerprint still open on HEAD
   - Drop findings below confidence threshold (configurable, default 0.6)

5. **Acknowledge fixes** (port from `pr-review-bot-loop`)
   - Re-check prior findings on HEAD (`thread-verify` pattern)
   - Reply on old comment: “Fixed on `{short_sha}`” or mark review thread resolved
   - Use `doc-audit-verify.mjs` logic for audit-doc findings

6. **Deterministic rules (first slice)**
   - Port `doc-audit-verify.mjs` into `packages/rules/`
   - Run on changed `.md` audit docs before LLM (free, no hallucinations)

### Tickets

| # | Task | Notes |
|---|------|-------|
| 2.1 | Postgres/KV schema for PR state | Migrations or D1 |
| 2.2 | `fingerprint(finding)` | Stable across minor message edits |
| 2.3 | `diffSince(last_sha, head_sha)` | GitHub compare API or git |
| 2.4 | Merge new + prior findings | New / still-open / fixed |
| 2.5 | Suppress duplicate posts | Match on fingerprint |
| 2.6 | `verifyFindingOnHead(finding, sha)` | Port HEAD check from `thread-verify.mjs` |
| 2.7 | Reply “fixed on …” on superseded comments | GitHub API |
| 2.8 | Wire `doc-audit-verify` pre-LLM | Findings get `rule_id: audit.*` |

### Exit criteria

- [ ] Push 3 commits fixing issues → bot does not triple-post same finding
- [ ] Fixed issues get “fixed on `{sha}`” acknowledgment
- [ ] Audit doc table/pipe issues caught without LLM
- [ ] State survives worker restart

### Port from existing skill

| Module | Use |
|--------|-----|
| `doc-audit-verify.mjs` | Deterministic audit markdown rules |
| `thread-verify.mjs` | HEAD re-check pattern for own findings |
| `readFileAtRef` (qodo-verify) | Read file at `head_sha` via git/API |

---

## Phase 3 — “Feels professional”

**Time:** 1–2 weeks  
**Goal:** Trust it on real Velatrix PRs (#67-style code, audit docs).

### Deliverables

1. **GitHub Review API (inline comments)**
   - `POST .../pulls/{n}/reviews` with `event: COMMENT` or `REQUEST_CHANGES` (P1 only)
   - Inline on diff lines for P1/P2; summary comment for rest
   - **Cap: 8 comments/PR** (configurable)

2. **Rules-before-LLM (full deterministic layer)**
   - `doc-audit-verify.mjs` — audit docs
   - Semgrep on changed paths (Velatrix ruleset)
   - Custom scripts: restream fail-closed, route-registration patterns, etc.
   - LLM runs only on hunks with no deterministic hit **or** `strict` mode

3. **`.velatrix-review.yml` in target repo**
   ```yaml
   mode: normal          # strict | normal
   ignore:
     - "**/package-lock.json"
     - "**/dist/**"
   include_docs: false   # skip docs/audits unless true
   max_comments: 8
   max_tokens: 50000
   ```

4. **Severity / confidence filter**
   - Post inline only ≥ medium severity and ≥ 0.7 confidence
   - P1 → may use `REQUEST_CHANGES`; P2+ → `COMMENT`

5. **Cost & safety**
   - Token budget per PR; truncate large files (“reviewed first 200 lines”)
   - Never send `.env` contents; redact `AKIA…`, `ghp_…`, JWT patterns in diff

6. **Optional GitHub Check**
   - Check run `velatrix-review`: `success` | `neutral` (warnings) | `failure` (P1 open)
   - Useful for branch protection later; not a merge gate by default

7. **Human override (simple)**
   - Label `review-bot:ignore` → skip PR
   - Keyword blocklist in config for repeated false positives

8. **Ops baseline** (ongoing after ship)
   - Alert on webhook 5xx, queue backlog, LLM timeout
   - Metrics: cost/PR, findings count, time-to-review
   - Prompt version pin; eval on 10–20 past Velatrix PRs

### Tickets

| # | Task | Notes |
|---|------|-------|
| 3.1 | `postPullRequestReview(summary, inline[])` | Line must be in diff |
| 3.2 | Semgrep runner in worker | Changed paths only; parse SARIF → findings |
| 3.3 | Merge deterministic + LLM findings | Dedup by file+line |
| 3.4 | Load `.velatrix-review.yml` from PR head | Fallback defaults |
| 3.5 | Path filter + generated file skip | Respect `ignore` globs |
| 3.6 | Token cap + diff truncation | Log truncated files in summary |
| 3.7 | Secret redaction pre-LLM | Regex pass on patch text |
| 3.8 | Check run integration | Optional per repo |
| 3.9 | Label `review-bot:ignore` | Early exit in worker |
| 3.10 | README: install app, config, local dry-run | |
| 3.11 | Eval harness: replay N past PRs | Compare to CodeRabbit/Greptile |

### Exit criteria

- [ ] Inline comments on real Velatrix PR with ≤8 total
- [ ] Semgrep + doc-audit catch issues without LLM
- [ ] `.velatrix-review.yml` honored
- [ ] You’d use it daily instead of paying for CodeRabbit on Velatrix-Cloud
- [ ] Runs 2+ weeks without manual babysitting

### Don’t replace CI

Bot **suggests**; Semgrep CI + tests still gate merge. Check run is informational unless you opt in.

---

## Phase 4 — “Greptile-lite” (optional)

**Time:** 2–4 weeks  
**Goal:** Cross-file context when diff-only misses bugs.

**Skip until Phase 3 feels limiting** — indexing is where scope explodes.

### Deliverables

1. Index `main` (embeddings or symbol graph) — Velatrix-Cloud only at first
2. On PR: retrieve related files for changed imports/symbols (e.g. auth middleware)
3. Multi-model routing: Haiku triage → Sonnet deep review on flagged hunks
4. Optional: multi-repo dashboard

### Exit criteria

- [ ] Catches “this breaks auth in `middleware/auth.js`” on a 5-line diff in a caller

---

## Cross-cutting requirements (all phases)

| Requirement | Phase introduced |
|-------------|------------------|
| Structured JSON from LLM | 1 |
| Rules before LLM | 2 (doc-audit), 3 (Semgrep + custom) |
| HEAD verify before “fixed” | 2 |
| Incremental re-review | 2 |
| Webhook idempotency (`head_sha` dedupe) | 1 |
| Per-PR concurrency / push coalescing | 1 |
| Skip self-authored PRs (app bot) | 1 |
| Ignore `edited` / title-only (no `synchronize`) | 1 |
| `.velatrix-review.yml` | 3 |
| Cost cap + secret redaction | 1 (basic), 3 (full) |
| Status check | 3 |
| Human override (label) | 3 |

---

## Timeline summary

| Phase | What | Time | Must-have? |
|-------|------|------|------------|
| **1** | GitHub + queue + first comment | 3–5 days | ✅ |
| **2** | Re-review + dedup + doc-audit | 3–5 days | ✅ |
| **3** | Inline + Semgrep + config + ops | 1–2 weeks | ✅ for daily use |
| **4** | Repo index / cross-file | 2–4 weeks | ❌ optional |

**To “GitHub connect + review on open + re-review on push”:** Phases 1–2 (~2 weeks part-time).

**To “daily driver” you’d actually trust:** Phases 1–3 (~4–6 weeks part-time, ~2 weeks full-time if reusing pr-review-bot-loop).

**To “mini Greptile”:** add Phase 4 → ~2–3 months total.

---

## Phase 1 — start tomorrow (ticket order)

1. **GitHub App** — create app, note App ID, generate private key, set webhook URL (ngrok/Worker preview), install on **Velatrixcloud**, restrict to **Velatrixcloud/Velatrix-Cloud**
2. **Scaffold repo** — `apps/webhook`, `apps/worker`, `packages/github`, env template
3. **Webhook** — signature verify, parse payload, push to queue
4. **Worker** — pop job, log `{ pr, head_sha, action }`
5. **GitHub client** — installation token, list PR files, get patch
6. **LLM** — prompt + JSON schema + Velatrix rules file
7. **Post comment** — format findings as markdown table
8. **CLI** — `pnpm review --repo Velatrixcloud/Velatrix-Cloud --pr 67`
9. **Smoke test** — open test PR, confirm comment within 2 min

---

## MVP vs Greptile

| Greptile has | MVP needs? |
|--------------|------------|
| Full repo embeddings | ❌ |
| Chat with codebase | ❌ |
| Multi-tenant SaaS | ❌ |
| 36 review workers @ scale | ❌ |
| Multi-model router | ⚠️ Phase 4 |
| PR open + re-push review | ✅ |
| GitHub integration | ✅ |

**~30% of Greptile’s product, ~5% of their infra complexity.**
