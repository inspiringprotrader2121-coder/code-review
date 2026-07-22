# Orvex — 24-Agent End-to-End Codebase Audit

**Audit date:** 2026-07-17
**Scope:** Full monorepo (`packages/*`, `apps/*`) inspected end-to-end by 24 parallel sub-agents.
**Severity taxonomy:** CRITICAL → HIGH → MEDIUM → LOW.
**Status legend:** ✅ Fixed & verified · 🔧 In progress · ⬜ Pending · ❎ Rejected (false/won't-fix)

---

## Summary

| Severity | Count | Fixed | Pending |
|----------|-------|-------|---------|
| CRITICAL | 1 | 1 | 0 |
| HIGH | ~12 | 12 | 0 |
| MEDIUM | ~21 | 12 core items | ~9 (folded sub-findings/low nits) |
| LOW | several | 0 | several |

> The dominant pattern in the HIGH tier: ~8 of 12 are **incomplete/regressed versions of my own prior fixes** — the named example was patched but sibling call-sites were missed. Directive: fix **every** instance, not just the cited one.

---

## CRITICAL

### C1 — `codex-cli.ts` sandbox hardening ✅
- **File:** `packages/review/src/codex-cli.ts`
- **Issue:** Codex CLI execution path is a latent RCE surface. Currently gated **off** in prod (codex-CLI disabled), but the code exists.
- **Fix:** First-party repo allowlist (`ORVEX_CODEX_CLI_REPOS`), enforced in BOTH layers, independent of the feature flag: `runCodexCliReview` refuses a repo checkout (`cwd`) unless `repoId` is allowlisted (drops to diff-only with a loud log), and `pipeline.ts` skips the checkout for non-allowlisted repos and passes `repoId`. Regression tests in `codex-cli.test.ts` (fail-closed default, case-insensitive match, missing repoId refused, `*` escape hatch).

---

## HIGH

### H1 — `redact.ts` secret-redaction gaps ✅
- **File:** `packages/review/src/redact.ts` (+ `redact.test.ts`)
- **Issue:** Secrets could reach the third-party LLM: (a) `SCREAMING_SNAKE` env secrets (`FOO_SECRET=...`) not matched; (b) `Authorization: Bearer <token>` not matched; (c) userless connection strings (`redis://:pass@host`) not matched.
- **Fix:** Added SCREAMING_SNAKE env-secret rule, Bearer rule, made conn-string username optional. Empirically verified 12 secret shapes redact and 3 prose negatives are preserved.

### H2 — `llm.ts` transient-error misclassification ✅
- **File:** `packages/review/src/llm.ts` (+ `llm.test.ts`)
- **Issue:** `isTransientLlmError` treated permanent 4xx (400/401/403/404/405/409/410/413/422) as retryable → infinite retry on a dead request. `maxFindings` sliced arbitrarily instead of by severity. Unknown severity coerced to `P3` (a real bug level).
- **Fix:** All HTTP 4xx are non-transient except the explicit retry-later statuses 408/425/429; `maxFindings` sorts by severity + logs before slice; unknown severity → `info` (fail toward nitpick).

### H3 — `import-check.ts` false-positive P1 on re-exports ✅
- **File:** `packages/review/src/import-check.ts`
- **Issue:** `DYNAMIC_EXPORT_RE` flagged `export {...} from` and `export * as X from` as dynamic-export bugs at 0.97 confidence.
- **Fix:** Regex now bails on named/namespace re-export forms.

### H4 — `format.ts` GFM injection via finding text ✅
- **File:** `packages/review/src/format.ts`
- **Issue:** Finding text and file cells were emitted raw into Markdown tables/checkboxes → GFM injection (checkbox spoof, table break, fence break).
- **Fix:** `sanitizeFindingText` defangs all checkbox variants; new `sanitizeFileCell` strips `|` and backticks (applied to 3 table cells); Suggestions block sanitizes message + file; `buildAgentPrompt` safeCode() neutralizes marker + 4+-backtick fence-break.

### H5 — `verifier.ts` prompt-injection in verify paths ✅
- **File:** `packages/review/src/verifier.ts`
- **Issue:** `verifyFixes` lacked sentinel injection defense; `verifyFindings` did not sanitize the file **path** (outside the guarded region).
- **Fix:** Full sentinel wrap + strip over file/findingMessage/originalCode/fixedCode in `verifyFixes`; `safePath` strips newlines + sentinel in `verifyFindings`.

### H6 — `merge.ts` high-severity findings falsely auto-closed ✅
- **File:** `packages/review/src/merge.ts` (+ `merge.test.ts`)
- **Issue:** Deterministic `fixLanded` could close a P1/P2 on weak `fixedCode`-present evidence (incidental rename false-closes a still-open bug).
- **Fix:** P1/P2 are **never** deterministically closed — deferred to `mergeFindings` model-recall authority. Added HIGH-SEVERITY GUARD test.

### H7 — `commands.ts` command-parsing spoofs ✅
- **File:** `packages/review/src/commands.ts` (+ `commands.test.ts`)
- **Issue:** (a) `@orvexander` (trigger as prefix of a longer handle) fired a job; (b) quoted/blockquote/fenced `> @orvex fix all` re-triggered destructive `fix_all`; (c) casual mentions (`@orvex thoughts?`, 3-word prose) enqueued paid prompt jobs via loose ≥3-words / trailing-`?` heuristics.
- **Fix:** Strip fenced + blockquote lines before scanning; require whitespace/EOL boundary **after** the trigger; require a recognized imperative verb before enqueuing a prompt job. All 8 command tests pass.

### H8 — `diff.ts` compare-diff pagination drops files ✅
- **File:** `packages/github/src/diff.ts`
- **Issue:** `fetchCompareDiff` relies on `octokit.paginate` which does **not** aggregate `res.data.files` → large PRs silently lose files.
- **Fix:** Uses `octokit.paginate.iterator` concatenating `res.data.files` across pages; the 3000-file cap is handled explicitly (stops paging + logs TRUNCATED). Multi-page aggregation is covered by `diff.test.ts`.

### H9 — `billing.ts` sub-lifecycle guard downgrades paying tenants ✅
- **File:** `apps/server/src/routes/billing.ts`
- **Issue:** The earlier double-subscription fix downgrades a just-upgraded paying tenant, because deleted/updated handlers act on any sub event.
- **Fix:** New `isCurrentSubscription()` guard — `customer.subscription.updated`/`deleted` only mutate state when `object.id` matches the tenant's current `stripeSubscriptionId` (superseded-sub events are logged + ignored); `created` is exempt (it announces the new sub). Tests in `billing.test.ts`.

### H10 — `pipeline.ts` run recorded on wrong SHA + tier-rescue restores refuted findings ✅
- **File:** `apps/server/src/pipeline.ts`
- **Issue:** Run recorded on `job.headSha` instead of `effectiveSha`; tier-rescue restores factually-refuted findings (rescue should be reason-based, not blanket-restore).
- **Fix:** New `store.setReviewRunHeadSha()` re-points the running row at the real head when it moved since enqueue (cooldown/dedup/scorecard all key on `head_sha` — tested in `database.test.ts`). Tier-rescue is now reason-based via `isHedgedRejection()`: protected-tier findings are rescued only on hedged/low-information vetoes ("cannot verify", "validated elsewhere"); factual refutations stand and are logged (tests in `pipeline.test.ts`).

### H11 — `redis.ts` orphan recovery + enqueue races ✅
- **File:** `packages/queue/src/redis.ts`
- **Issue:** `recoverOrphans` can crash-loop (no `resumedAfterRestart` guard); enqueue→coalesce is TOCTOU (not atomic); `MAX_DEDUP_ENTRIES` NaN guard missing.
- **Fix:** (a) Resume counter per job (`orvex-review:resumed:*`, 24h TTL) — past `ORVEX_MAX_RESUME_AFTER_RESTART` (default 2) the orphan is DROPPED with a loud log instead of crash-looping the worker. (b) Enqueue decision (inflight→coalesce vs main queue) and dequeue claim-or-stash are each ONE Lua script — a job can no longer land in pending after the final drain and strand. (c) `MAX_DEDUP_ENTRIES` (memory.ts) is NaN/≤0-guarded back to 20 000.

### H12 — `database.ts` correctness cluster ✅
- **File:** `packages/store/src/database.ts`
- **Issue:** email unique-index crash (need dedup before create); `tenant_id` not refreshed on repo/PR upsert; `saveState` not a single transaction; `findInstallationForRepo` N+1 dead loop; stale `deep=3` comment (should be 2).
- **Fix:** (a) duplicate emails nulled (oldest row kept) before `CREATE UNIQUE INDEX`, with a loud log; (b) `tenant_id = excluded.tenant_id` added to the repo AND pull_request upserts (test: re-linked installation moves the repo); (c) `saveState` upsert + findings projection wrapped in one `db.transaction`; (d) N+1 loop + dead `slug` removed — single indexed query remains; (e) comment corrected to 2 units.

---

## MEDIUM

### M1 — `diff-filter.ts` omitted-patch files counted as reviewed ✅
- **File:** `packages/github/src/diff-filter.ts`
- **Fix:** Files with an omitted `patch` now count as `omittedPatch` in `DiffCoverage`, are excluded from `reviewed`, and force `complete: false` (non-removed only — deletions stay informational). Surfaced in the worker's PARTIAL log and the PR partial-coverage banner.

### M2 — `repo-context.ts` snapshot context regressed ✅
- **File:** `packages/github/src/repo-context.ts`
- **Fix:** Snapshot now uses `maxFileBytes: Math.max(maxFileBytes, 120_000)` — small-budget callers (nightly 24KB / autofix 32KB) no longer shrink the snapshot; the per-file `clip` still bounds what reaches the prompt. Regression test in `repo-context.large-file.test.ts`.

### M3 — `repo-index.ts` ranking + fallback issues ✅
- **File:** `packages/github/src/repo-index.ts`
- **Fix:** Scores length-normalized (`/ √tokens`, big files no longer dominate); changed files missing from the snapshot fall back to PATH-derived query tokens (per-segment); SQL + shell stopwords added. Three regression tests in `repo-index.test.ts`.

### M4 — `runtime-verify.ts` blames PR for pre-existing failures ✅
- **File:** `apps/server/src/runtime-verify.ts`
- **Fix:** Base-vs-head comparison — when head fails and `baseSha` is known (pipeline now passes `pr.baseSha`), the same steps run at base and failures reproducing there are marked `preExisting` and reported as "pre-existing, NOT introduced by this PR". Success message names the steps that ACTUALLY ran. The shared classifier and formatter are covered in `runtime-verify.test.ts`.

### M5 — `webhook.ts` delivery dedup + config reload ✅
- **File:** `apps/server/src/routes/webhook.ts` (the route handler; `packages/github/src/webhook.ts` is signature-only)
- **Fix:** Dedup on `X-GitHub-Delivery` (bounded 10k FIFO set, applied after signature verification) — successful redeliveries return `{deduped:true}` instead of double-enqueuing fix-all/double-posting replies. A delivery claim is released when parsing or processing throws, so GitHub can retry transient failures. GitHub config loads ONCE (lazy) instead of re-reading the PEM per request. Covered by `webhook-dedup.test.ts`.

### M6 — `queue-runner.ts` pump-loop state + retry clamp ✅
- **File:** `apps/server/src/queue-runner.ts`
- **Fix:** `running`/`isDeployDraining()`/`isPaused()` re-checked per pump-loop iteration (a mid-tick drain flag now stops further dequeues in the same tick); `MAX_JOB_RETRIES` clamped to 0–10 with NaN→2 fallback.

### M7 — `plans.ts` prototype pollution + dead overage revenue ✅
- **File:** `packages/tenants/src/plans.ts`
- **Fix:** `planFeatures` + `defaultPlanId` use `Object.hasOwn` (regression test: `constructor`/`__proto__` fall through to free). The "overage unreachable" claim was VERIFIED FALSE against current code — `accountLimitReason` deliberately skips the monthly hard block for metered plans and `reportStripeReviewOverage` is live (both covered by `account-limits.test.ts` / `billing.test.ts`); the two quota fields' docs were reconciled to state which one governs.

### M8 — `email-identity.ts` disposable-domain matching ✅
- **File:** `packages/tenants/src/email-identity.ts`
- **Fix:** `isDisposableEmail` subdomain-matches (`domain === d || domain.endsWith('.'+d)`); empty-local/no-domain edges return false. Tests added.

### M9 — `auth.ts` legacyConnectMode inconsistency ✅
- **File:** `apps/server/src/routes/auth.ts`
- **Fix:** `legacyConnectMode()` now takes and passes `db.hasPasswordUsers()` at all 3 call sites — once any password account exists, `/connect` requires a session.

### M10 — `config.ts` (github) silent config discard ✅
- **File:** `packages/rules/src/config.ts` (where `parseReviewConfigYaml` actually lives)
- **Fix:** `safeParse` + `console.warn` on malformed YAML and on schema-validation failure (never silently discards all keys); `inline_min_confidence` is now WIRED — below-floor findings go to the summary table instead of inline (`filter.ts` + tests).

### M11 — Eval harness scoring integrity ✅
- **Files:** `apps/eval/src/bench/{competitors,severity-check,judge,diagnose}.ts` (+ new shared `severity.ts`)
- **Fix:** Shared `severityOf` anchors to the label region (P-labels anywhere, `Severity: X` labels, keywords only in the comment head with negation stripped) with High/Medium/Low + Major/Minor mapping and P0→P1 folding; clusters no longer merge cross-tool null-line findings (`sameClusterLine`); judge max-folds cluster severity; diagnose's near-window tightened 12→5; CodeRabbit skip/limit patterns expanded. Tests in `severity.test.ts`.

### M12 — `deploy-safe.sh` stale-lock reclamation ✅
- **File:** `scripts/deploy-safe.sh`
- **Fix:** The deploy lock now carries holder/PID/epoch metadata; a lock older than `DEPLOY_LOCK_STALE_S` (default 6h) is reclaimed (metadata epoch, dir-mtime fallback for legacy locks). Linux `flock` serializes inspection and takeover so concurrent reclaimers cannot remove one another's newly acquired lock. `deploy-safe.test.sh` checks the lock guard and exercises fresh/stale paths.

> Additional MEDIUM items surfaced by the audit are folded into the clusters above (database.ts, redis.ts, pipeline.ts each carry multiple sub-findings). Remaining low-severity nits are tracked inline in code review comments.

---

## Fix / verify protocol (per project rules)

1. Verify each finding against **current** source before fixing — skip anything already fixed or mischaracterized.
2. Fix in batches, most-severe first.
3. After each fix, run the related test suite (extend tests to cover the fix).
4. Typecheck all 8 packages.
5. Deploy via `scripts/deploy-safe.sh --restart` (never raw rsync; never sync `node_modules`/`.env`/`*.db`/`*.pem`).
6. Verify each fix live on the server; confirm zero production-source drift.

---

## Progress log

- **2026-07-17** — HIGH tier: H1–H7 fixed & verified (review package, 108 tests passing incl. new regression tests). H8–H12 pending. CRITICAL C1 pending. MEDIUM tier pending.
- **2026-07-17 (later)** — ALL remaining items fixed & verified: C1, H8–H12, M1–M12. Every finding was re-verified against current source first; one sub-claim rejected (M7 "overage unreachable" — already reachable by design, docs reconciled instead). Full monorepo: typecheck clean (8 packages), 270 tests passing (up from ~240), `deploy-safe.test.sh` green. NOT yet deployed (per project rules: `scripts/deploy-safe.sh --dry-run` → `--restart` when ready).
- **2026-07-17 (independent current-disk verification)** — Closed three residual gaps found during a second local audit: complete permanent-4xx classification (H2), failure-aware delivery dedup (M5), and serialized stale-lock takeover (M12). Added durable compare pagination, command spoof, re-export, webhook retry, and runtime base/head classifier regressions. Full local suite now has 276 tests; all 8 package typechecks and `deploy-safe.test.sh` pass. Redis Lua behavior remains statically reviewed but requires a real Redis integration environment for end-to-end concurrency verification. Live deployment was not performed in this verification pass.
