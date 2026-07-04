# Orvex Review — improvement plan

**Product name: Orvex Review** (codebase still says `velatrix-review` everywhere — see Track 0).
Goal: take the working single-app review bot and turn it into a proper multi-tenant
code-review SaaS, while making the reviews themselves measurably better.

**Dashboard + landing design:** see the published mockup (landing page & tenant
dashboard, light/dark) — build `apps/web` against it.

---

## Where we are today (July 2026)

Shipped (old phases 1–3):

- Webhook → queue → diff → rules → LLM → capped inline review, via `apps/server/src/pipeline.ts`
- SQLite store (`packages/store`): tenants, installations, PR state, findings
- Fingerprint dedup, incremental `last_sha..head_sha` re-review, "✅ Fixed on sha" replies
- Deterministic layer: doc-audit + Semgrep before LLM
- `.velatrix-review.yml` per-repo config, `review-bot:ignore` label, check runs
- Multi-tenant scaffolding: `packages/tenants`, `/connect` + install callback, per-installation scoping
- CLI one-shot review, secret redaction pre-LLM

Gaps blocking a sellable product:

- No user accounts or login — anyone who knows a workspace slug can claim it via `/connect`
- No web UI (no dashboard, no findings browser)
- SQLite single-node; in-memory queue is the default; single worker
- No usage metering (`review_runs` never persisted with duration/cost), no billing, no plan limits
- No eval harness — review-quality changes can't be measured
- GitHub App private key sits on local disk; no secret manager, no audit log

---

## Track 0 — Rename to Orvex (½–1 day, do first)

**Status: ✅ done in code (2026-07-04).** Packages are `@orvex-review/*`, config is
`.orvex-review.yml` (reads `.velatrix-review.yml` as fallback), check run / bot / db
defaults renamed, legacy db path auto-detected. Remaining manual step: rename the
GitHub App itself (slug + bot login) on GitHub, then update `.env` to match.
Local `.env` still points at the old slug/pem on purpose so the current install keeps working.

| # | Task |
|---|------|
| 0.1 | Rename packages `@velatrix-review/*` → `@orvex-review/*`; update imports, `pnpm-workspace`, tsconfig paths |
| 0.2 | Config file becomes `.orvex-review.yml`; keep reading `.velatrix-review.yml` as a deprecated fallback for one release |
| 0.3 | Register/rename GitHub App → slug `orvex-review`, bot `orvex-review[bot]`; update `GITHUB_APP_SLUG`, `GITHUB_APP_BOT_LOGIN` |
| 0.4 | Check run name → `orvex-review`; default `STORE_PATH` → `.data/orvex-review.db` (migrate/rename existing db) |
| 0.5 | README / docs / examples renamed; `docs/SAAS_SETUP.md` updated |

---

## Track 1 — SaaS foundation (critical path)

### A. Identity & onboarding (1–2 weeks)

**Status: ✅ scaffolded (2026-07-04).** GitHub OAuth login (`/auth/login`,
`/auth/oauth/callback`, `/auth/logout`, `/api/me`), `users`/`sessions`/`workspace_members`
tables, session cookies, membership-guarded `/connect` + install callback, and the
slug-claiming hole is closed (`WorkspaceAccessError`). `AUTH_DISABLED=1` gives a dev
bypass. To go live: create the GitHub App's Client secret, set
`GITHUB_OAUTH_CLIENT_ID/SECRET`, and set the app's Callback URL to
`{APP_URL}/auth/oauth/callback`.

- GitHub OAuth **user** login (distinct from the App installation)
- Tables: `users`, `workspace_members(user_id, tenant_id, role)`
- Sessions (signed cookie or Lucia/Auth.js); every dashboard/API request resolves an authenticated `tenant_id`
- Onboarding flow: sign in → create/name workspace → install GitHub App → land on dashboard with first repo connected
- Close the slug-claiming hole in `TenantService.startConnect` (workspace creation requires an authenticated user; install `state` binds user + tenant)

**Exit:** a stranger cannot see or claim another workspace; new user reaches "first review posted" in <10 min.

### B. Postgres + metrics (≈1 week)

**Status: metrics half ✅ (2026-07-04), Postgres pending.** `review_runs` table exists
and `pipeline.ts` records every run (completed / skipped / failed, duration, finding
counts); `getWorkspaceStats` + `listReviewRuns` power `/api/workspaces/:slug/{stats,reviews}`.
Also: better-sqlite3 bumped to v12 (Node 24 prebuilds). Postgres migration still to do.

- Migrate `packages/store` SQLite → Postgres (Drizzle recommended; store is already a thin interface)
- New tables:
  - `review_runs(id, tenant_id, installation_id, repo, pr, head_sha, status, skip_reason, duration_ms, input_tokens, output_tokens, cost_usd, findings_new, findings_fixed, created_at)`
  - monthly usage roll-up per workspace
- Emit one `review_runs` row from `pipeline.ts` — this single change powers every dashboard tile/chart
- Migration CI (drizzle-kit) + seed script

**Exit:** dashboard stats computable from SQL; state survives horizontal workers.

### C. Dashboard web app (2–3 weeks)

- New `apps/web` (Next.js or Vite + Hono API), built from the published design
- Screens: Overview (tiles, reviews/day chart, severity + source breakdowns), Reviews list, Findings browser (filter by repo/severity/status/source), Repositories, Rules & config, Installations, Usage & billing, Members
- API: `GET /api/workspaces/:slug/{stats,reviews,findings,installations}` — all tenant-scoped by session
- Manual "Run review" button → enqueue job (same path as CLI)

**Exit:** a customer can self-serve from install to browsing findings without touching a terminal.

### D. Queue & workers hardening (a few days)

- Redis queue (`packages/queue/redis.ts` → default in prod; BullMQ or keep custom)
- Move idempotency key `(repo, pr, head_sha)` and per-PR lock into Postgres so N workers coalesce correctly
- Retries with backoff, dead-letter queue, alert on DLQ growth / queue depth

### E. Billing & plan limits (1–2 weeks)

- Stripe subscriptions per workspace: Solo $0 (1 repo, 50 reviews/mo) · Team $49 (unlimited repos, 500 reviews/mo then metered) · Enterprise (BYOK, self-host, SSO)
- `tenants.plan` + limits enforced **at enqueue time**; over-limit surfaces as neutral check run + dashboard banner, never a silent drop
- Meter from `review_runs`; webhook-driven subscription state sync

**Exit:** a workspace can pay, hit a limit, see why, and upgrade — all self-serve.

---

## Track 2 — Review quality (the moat)

**Status update (2026-07-04): interactive fixes shipped.**

- Findings now carry `originalCode`/`fixedCode`; inline comments render native
  ```suggestion blocks (per-issue *Commit suggestion* button + diff preview) and
  an Orvex `Apply fix` checkbox per finding.
- Comment commands: `@orvex review | fix | fix all | fix this | <instructions> | auto-apply on/off | help`
  (trigger configurable via `ORVEX_TRIGGER`). Commands ack with 👀, results with 🚀.
- Fix engine (`apps/server/src/autofix.ts`): commits to the PR branch via the
  Contents API with a three-layer concurrency guard — per-PR fix lock in SQLite,
  head-sha re-check before every file commit, and content-anchor verification
  (`applyFixToContent` refuses when the code drifted). Fork PRs are declined.
- `@orvex auto-apply on` persists per-PR (`pr_settings`) and auto-commits ready
  fixes after each future review — Orvex's own findings only.
- Fix runs are recorded in `review_runs` (`action = fix:<scope>`).
- **Manual step:** GitHub App needs `Contents: Read & write` + subscribe to
  **Issue comment** and **Pull request review comment** events.
- Also shipped: `@orvex ignore` (per-repo fingerprint suppression, filtered pre-post),
  `@orvex explain` (LLM deep-dive reply on a finding), fix commits co-authored with
  the requester, fix-rate cap (`ORVEX_MAX_FIX_RUNS_PER_DAY`, default 30), and a
  styled onboarding flow (`/connect` → install → success, friendly error pages).
- Not yet: single-commit batching via the Git Trees API (currently one commit per
  file), validating `originalCode` against the diff at review time.

Ordered; 2.1 comes first because nothing else can be judged without it.

| # | Feature | Notes |
|---|---------|-------|
| 2.1 | **Eval harness** | Replay 10–20 past PRs with known-good findings; score precision/recall + cost per prompt/model change. Old ticket 3.11 — now mandatory before any prompt work |
| 2.2 | **False-positive feedback loop** | 👎 reaction or `/orvex ignore` reply on a finding → per-repo suppression list (by fingerprint/rule); dashboard shows suppressed count |
| 2.3 | **Comment commands** | `/orvex review` (force re-run), `/orvex explain` (expand a finding), `/orvex ignore` |
| 2.4 | **GitHub suggested changes** | Emit ```suggestion blocks for one-line fixes so authors can 1-click apply |
| 2.5 | **PR summary upgrade** | Risk-ranked "what changed" digest + test-coverage note at top of review |
| 2.6 | **Multi-model routing** | Haiku triage pass → flagship model only on flagged hunks; target cost <$0.05/PR median |
| 2.7 | **Confidence calibration** | Fit the 0.6/0.7 thresholds against the eval set instead of guessing |
| 2.8 | **Custom rule packs** | Workspace-editable rules (markdown) in dashboard, versioned, injected into the prompt; Semgrep pack upload |
| 2.9 | **Cross-file context** (old Phase 4) | Symbol-graph / changed-imports retrieval so a 5-line diff can flag the breakage in `middleware/auth.js`; keep scoped — no full-repo embeddings until this proves limiting |
| 2.10 | **Monorepo awareness** | Path-scoped configs (`apps/web` vs `packages/*` rules), per-path reviewers |

**Exit:** eval precision ≥ 80% at current recall; false-positive rate visibly trending down in dashboard.

---

## Track 3 — Platform & ops

- Structured logs (pino) + metrics: time-to-review, cost/PR, queue depth, GitHub API budget; alerts on webhook 5xx, DLQ, LLM timeout
- Handle GitHub secondary rate limits (retry-after, per-installation throttling)
- Deploy story: Dockerfile + fly.io/Railway/ECS; staging environment; health/readiness endpoints (health route exists)
- Prompt version pinning + changelog; roll back via env
- Status page (public)

## Track 4 — Security & trust

- App private key + webhook secret into a secret manager (not repo dir); rotation procedure documented
- Encrypt BYOK Anthropic keys at rest (per-tenant data key)
- Audit log per workspace (installs, config changes, member changes, manual runs)
- Data retention: never store raw diffs; purge findings/runs after N days (configurable); document what the LLM sees
- Tenant-isolation tests: cross-tenant access attempts in CI
- Market the existing secret-redaction pass — it is a real differentiator

## Track 5 — DX & docs

- README rewrite for Orvex (SaaS + self-host paths)
- CLI: `orvex review --pr N`, `orvex replay` (eval), `orvex doctor` (env/webhook checks)
- OpenAPI spec for the dashboard API; typed client shared with `apps/web`
- Public docs site: install guide, config reference, command reference

---

## Milestones

| Milestone | Contents | Target |
|-----------|----------|--------|
| **M0** | Track 0 rename + 2.1 eval harness | week 1 |
| **M1** | 1A auth/onboarding + 1B Postgres/metrics | weeks 2–4 |
| **M2** | 1C dashboard + 1D queue hardening | weeks 5–7 |
| **M3 (GA)** | 1E billing + Track 3 ops baseline + Track 4 secrets/audit | weeks 8–10 |
| **M4** | Quality moat: 2.2–2.6 | weeks 10–14 |
| **M5** | 2.8–2.10 cross-file & rule packs | after M4 proves demand |

Critical path: **M0 → M1 → M2 → M3**. Track 2 items can interleave whenever pipeline work is blocked.

### GA exit criteria

- [ ] Stranger cannot read or claim another workspace
- [ ] Install → first review → dashboard, fully self-serve, <10 min
- [ ] Two workers + Redis + Postgres survive a worker kill mid-review with no double-post
- [ ] Plan limits enforced and visible; Stripe upgrade works end-to-end
- [ ] Eval harness green on every prompt/model change
- [ ] No secrets on disk in production; audit log live
