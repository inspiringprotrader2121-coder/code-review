# How Orvex Review works

Orvex Review is a multi-tenant GitHub App that reviews pull requests with an LLM,
posts findings as inline comments with one-click fixes, and (on the top tier) runs
the changed code in a sandbox. This document explains the end-to-end flow, the two
plans, every trigger, and the configuration that controls it.

---

## 1. The end-to-end flow

```
GitHub event ──▶ /webhooks/github ──▶ queue ──▶ worker ──▶ review pipeline ──▶ GitHub PR
   (push,          (verify sig,       (Redis)   (bounded    (context → passes    (inline
    comment,        dedupe, gate)                concurrency) → sweep → verify)    comments,
    checkbox)                                                                       fixes)
```

1. **Webhook** (`apps/server/src/routes/webhook.ts`) — GitHub calls `POST /webhooks/github`.
   The signature is verified, the event is matched, and a job is enqueued.
2. **Queue** (`packages/queue`) — Redis-backed in production (`QUEUE_BACKEND=redis`),
   in-memory for dev. Jobs are deduped and per-PR locked so the same SHA isn't
   reviewed twice and commands never collide.
3. **Worker** (`apps/server/src/queue-runner.ts`) — a bounded pump pulls jobs and
   runs at most `ORVEX_MAX_CONCURRENT_REVIEWS` at once. Scale out by running more
   worker processes against the shared Redis queue.
4. **Review pipeline** (`apps/server/src/pipeline.ts`) — builds context, runs the
   review, verifies findings, posts the comment, records the run.

Every review is recorded in `review_runs` (a `running` row at start, finalized on
completion) so the dashboard shows it live.

---

## 2. The review engine

For each changed file the pipeline builds **deep context** and reviews against it.

- **Full changed files** — not just the diff hunks, so logic elsewhere in the same
  file (guards, error handling) is visible.
- **Import/dependency neighborhood** — files the change imports and files that
  import the change (`packages/github/src/repo-context.ts`).
- **Repo index retrieval** — a dependency-free TF-IDF index over code identifiers
  (`packages/github/src/repo-index.ts`) retrieves the top-K files across the *whole*
  repo most relevant to the change, so a 5-line diff can surface breakage in a file
  it doesn't directly import.

Depth is enforced in the harness (not left to the model), scaled **by plan**, and
all the calls **run in parallel with bounded concurrency** (`ORVEX_REVIEW_CONCURRENCY`)
so a deep review finishes in a few minutes, not tens of minutes:

- **Passes** — the review runs N times over the change + neighborhood + top-K
  index files; findings accumulate and dedupe by fingerprint.
- **Whole-repo sweep** (Verify/Enterprise only) — the rest of the repo is examined
  against the change in size-bounded batches (many files per batch) for exhaustive
  coverage, run concurrently with the passes.
- **Adversarial verification** — a second skeptical model pass tries to *refute*
  each finding against the source; it fails open (never drops a real finding on an
  error, after retries). Fix verification fails closed (never commits an unverified
  change).

Noise control: a rules prompt (`rules/orvex-rules.md`), a self-negating-finding
filter, per-repo `@orvex ignore` suppression, and a per-review comment cap.

---

## 3. The fix engine

Findings carry `originalCode`/`fixedCode` when a concrete fix is possible. The
inline comment renders a native GitHub **suggestion** block (one-click *Commit
suggestion* for single-line fixes) **and** an Orvex **apply-fix checkbox**. Ticking
the checkbox — or commenting `@orvex fix` — makes Orvex commit the fix to the PR
branch (`apps/server/src/autofix.ts`), guarded by a per-PR lock, a head-SHA
re-check, and content-anchor verification (it refuses if the code drifted). Fork
PRs are declined (can't push). Committing fixes is a **paid** capability.

---

## 4. Runtime verification — the Verify tier (TREX equivalent)

On the Verify plan, after the review Orvex can **run the change in a sandbox**
(`apps/server/src/sandbox.ts`, `runtime-verify.ts`): it materializes the PR head,
installs dependencies, and runs the repo's own typecheck/build/tests, then posts
pass/fail with the failing log tail as evidence. This catches build breaks, type
errors, and newly-failing tests that static review can't see.

The sandbox is hardened: ephemeral, non-root, read-only root FS, dropped
capabilities, memory/CPU/PID caps, network-isolated during tests, installs run with
`--ignore-scripts`, containers killed on timeout, and a global concurrency cap.

**Gating:** runs only when the tenant's plan has `codeExecution` **and**
`ORVEX_CODE_EXECUTION=1`. Off by default. Before enabling for untrusted (public)
repos, add an egress firewall (block cloud-metadata + RFC1918 during install) and a
disk quota on the sandbox work dir.

### Nightly whole-repo scans (Verify)

A scheduler (`apps/server/src/nightly.ts`) runs once a day (UTC hour
`ORVEX_NIGHTLY_HOUR`) and, for every Verify+ tenant's enabled repos, reviews the
last day's commits on the default branch — a diff the PR path never sees — and files
the findings as a GitHub **issue**. It reuses the full review engine (deep context,
passes, verification). Gated by `plan.nightlyScans` **and** `ORVEX_NIGHTLY_SCANS=1`;
off by default.

---

## 5. Plans

PRODUCT RULE (2026-07-09): **every plan runs the IDENTICAL pipeline** — 3
passes (general / deep-dive / perf+completeness), top-28 retrieval, strict
verification, autofix, code execution. Plans differ ONLY by (a) which MODELS
run and (b) volume/rate/price. Depth is never the tier differentiator.

| Capability | Free trial | Panel (`review`) | Panel Unlimited | Verify | Enterprise |
|---|---|---|---|---|---|
| Review passes | 3 | 3 | 3 | 3 | 3 |
| Index retrieval (top-K files) | 28 | 28 | 28 | 28 | 28 |
| Models | MiniMax + DeepSeek | MiniMax + DeepSeek | MiniMax + DeepSeek | OpenAI (codex CLI, agentic repo explore) + DeepSeek + MiniMax | MiniMax + DeepSeek |
| Strict verification | ✓ | ✓ | ✓ | ✓ | ✓ |
| Commit fixes / `@orvex` commands | ✓ | ✓ | ✓ | ✓ | ✓ |
| Code execution (runtime verify) | ✓ (flag) | ✓ (flag) | ✓ (flag) | ✓ (flag) | ✓ (flag) |
| Nightly whole-repo scans | — (uncapped-cost risk on unpaid) | ✓ (flag) | ✓ (flag) | ✓ (flag) | ✓ (flag) |
| Reviews | 10 lifetime, 2/hr | 5/hr, 75/mo (+$0.50 overage) | ∞ @ 10/hr | 10/hr, 150/mo (+$1.50 overage) | custom |

The hourly/monthly numbers are **safety ceilings, not usage targets** — sized as
tail-risk insurance (see `packages/tenants/src/plans.ts` for the cost math) so a
bug, restart loop, or repeated manual re-triggering can't silently run up an
unbounded bill on a flat subscription. A real team should never come close;
they're a backstop, not a constraint. Command/manual re-review of an unchanged
commit also has a 2-minute cooldown for the same reason — a fresh push is never
affected.

The tiers differ by **model mix and volume**, never depth: dual-model plans
run MiniMax (passes 1+3) + DeepSeek v4 Pro at max reasoning (pass 2); Verify
swaps pass 1 to the OpenAI frontier model via the codex CLI (API-key auth),
which agentically explores a full repo checkout. Code execution and nightly
scans sit behind ops flags (`ORVEX_CODE_EXECUTION`, `ORVEX_NIGHTLY_SCANS`).

Free is a **lifetime trial (10 reviews, 2/hour) anchored to the GitHub account** —
a second workspace or a reinstall can't reset it. Defined in
`packages/tenants/src/plans.ts`. Set a workspace's plan via the admin endpoint:
`POST /admin/tenants/:slug/plan` with `{ "plan": "verify" }` and a `Bearer`
`ORVEX_ADMIN_SECRET` (falls back to `REVIEW_API_SECRET`).

Billing model: plans are the product people buy; meter/credit only the expensive
execution runs. Over the free cap, Orvex nudges — it never silently drops.

---

## 6. Triggers

All triggers work on every plan; what differs is the **models/limits** they invoke
(table above). Comment commands require the commenter to have write access
(OWNER/MEMBER/COLLABORATOR). The trigger word is `@orvex` (configurable via
`ORVEX_TRIGGER`).

**Automatic**

| Trigger | Effect |
|---|---|
| PR opened / new commit (synchronize) / reopened | Full review at the tenant's plan depth |
| Tick the apply-fix checkbox on an Orvex comment | Commits that one fix (paid plans) |

Skipped automatically: draft PRs, Dependabot PRs, fork PRs (for fixes), repos
disabled in the dashboard, and PRs labeled `review-bot:ignore`. A second webhook for
the same SHA is deduped — only `@orvex review` forces a re-run.

**Comment commands**

| Command | Where | Effect |
|---|---|---|
| `@orvex review` / `re-review` | PR or inline reply | Fresh review, always runs (bypasses SHA dedupe) |
| `@orvex fix` | PR or inline reply | Commit ready fixes (paid) |
| `@orvex fix all` | PR or inline reply | Generate + commit fixes for all findings (paid) |
| `@orvex fix this` | inline reply | Fix that one finding (paid) |
| `@orvex explain` / `why` | inline reply | Deeper explanation of the finding |
| `@orvex ignore` / `dismiss` | inline reply | Suppress that finding's fingerprint for the repo |
| `@orvex resolve conflicts` | PR or inline reply | Resolve merge conflicts on the branch |
| `@orvex auto-apply on` / `off` | PR or inline reply | Per-PR: auto-commit ready fixes after each review (paid) |
| `@orvex <anything else>` | PR comment | Free-form instruction (answer or edit) |
| `@orvex help` | either | Post the command list |

**API / CLI**

| Trigger | Auth |
|---|---|
| `POST /review` `{owner,repo,pr}` | `Bearer REVIEW_API_SECRET` (required) |
| CLI (`pnpm review`) | local |

---

## 7. Multi-tenancy & isolation

Every workspace is a `tenant`; a GitHub installation belongs to exactly one tenant;
users are `workspace_members`. Every dashboard/API request resolves the session
user's membership before returning data, and every store query is scoped by
`tenant_id`/`installation_id`. Jobs carry their own `installationId`/`tenantId`, so
a review always uses the right GitHub token and posts to the right repo. The install
callback refuses to rebind an installation already owned by another workspace
(anti-takeover).

---

## 8. Configuration (key env vars)

| Var | Purpose |
|---|---|
| `MINIMAX_API_KEY` / `ANTHROPIC_API_KEY` | LLM provider (MiniMax preferred if set) |
| `MINIMAX_MODEL` / `ANTHROPIC_MODEL` | model id |
| `QUEUE_BACKEND` | `redis` (prod) or `memory` |
| `REDIS_URL` | Redis connection (with auth) |
| `ORVEX_MAX_CONCURRENT_REVIEWS` | reviews per worker process (default 4) |
| `ORVEX_REVIEW_CONCURRENCY` | parallel model calls within one review (default 3 — paces Verify to ~10 min) |
| `ORVEX_SWEEP_FILE_CHARS` | per-file read depth in the whole-repo sweep (default 10000) |
| `ORVEX_REVIEW_MAX_CALLS` | hard cap on model calls per review (default 28) |
| `ORVEX_REVIEW_THINKING` | `0` disables reasoning (on by default) |
| `ORVEX_CODE_EXECUTION` | `1` enables Verify-tier runtime verification (off by default) |
| `ORVEX_MAX_SANDBOXES` | global concurrent sandbox cap (default 2) |
| `ORVEX_NIGHTLY_SCANS` | `1` enables nightly whole-repo scans (off by default) |
| `ORVEX_NIGHTLY_HOUR` / `ORVEX_NIGHTLY_LOOKBACK_DAYS` | scan schedule (UTC hour, default 3) and window (default 1d) |
| `ORVEX_DEFAULT_PLAN` | plan for new signups (default `free`) |
| `ORVEX_IP_ABUSE_BLOCK` / `ORVEX_IP_MAX_ACCOUNTS_PER_DAY` | hard-block signups per IP (default: log-only, 5) |
| `ORVEX_ADMIN_SECRET` | auth for the plan-admin endpoint |
| `REVIEW_API_SECRET` | auth for `POST /review` (required) |
| `GITHUB_OAUTH_CLIENT_ID` / `_SECRET` | user login; without it the app runs in legacy no-login mode |
| `ORVEX_REQUIRE_LOGIN` | `1` forces login even without OAuth |
| `GITHUB_WEBHOOK_SECRET` | webhook signature verification |

---

## 9. Deployment

Node ≥ 20, pnpm workspace. Runs under pm2 behind nginx; SQLite store (Postgres
planned), Redis queue, Docker for the sandbox. Source of truth is the local repo —
changes are developed locally and `rsync`'d to the server; the server is never the
source of truth.
