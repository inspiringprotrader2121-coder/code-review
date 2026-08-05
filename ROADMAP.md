# Orvex — Best-on-Market Roadmap

Goal: the highest bug-catch-rate, lowest-noise, only-one-with-runtime-proof PR
reviewer, at a cost structure competitors can't match.

The four things buyers judge: (1) catches bugs others miss, (2) doesn't cry
wolf, (3) fixes what it finds in one click, (4) proves it publicly. Every phase
below maps to one of those.

---

## Phase 1 — The Scoreboard (eval loop) · ~2-3 days · $0 API cost

**Why first:** every other phase's success is unmeasurable without it. The repo
already contains ~50 PRs reviewed simultaneously by Orvex, OpenAI's
chatgpt-codex-connector, Qodo, and CodeRabbit — a ready-made benchmark dataset.

**Steps**
1. **Extract** (`tools/scoreboard/extract.ts`): for every PR (25→latest), pull
   all review comments via the GitHub API; group by bot login
   (`orvex-review[bot]`, `chatgpt-codex-connector`, `qodo-code-review[bot]`,
   `coderabbitai[bot]`); parse each into `{pr, bot, file, line, severity,
   summary}`. Output `scoreboard/findings.jsonl`.
2. **Match** across bots: same defect = same file + overlapping lines + same
   root cause (LLM-assisted matching on the summaries — one cheap MiniMax call
   per PR). Produces defect clusters: which bots caught each defect.
3. **Ground truth**: classify each defect cluster real/false-positive using
   (a) whether a later fix-PR touched that code, (b) the PR author's 👍/👎
   reactions, (c) LLM judgment with the full file as context. Mark uncertain
   ones for 5-minute human review (johnboy).
4. **Score**: per bot — catch rate (of all real defects found by anyone),
   unique catches, false-alarm rate, severity accuracy. Per-PR table + overall.
5. **Miss-pattern report**: cluster Orvex's misses by class (like the ESM
   `__dirname` class). Each systematic class → a new rule/lens in
   `rules/orvex-rules.md` (that loop already worked once).
6. **Make it repeatable**: `pnpm scoreboard` regenerates everything; run after
   every prompt/pipeline change. Keep history so changes show as deltas.

**Done when:** one command produces a table: Orvex vs 3 competitors, catch rate
+ noise rate, with a ranked list of Orvex's miss classes.

---

## Phase 2 — Runtime proof: actually run the code · ~1-2 weeks · the moat

**Why:** LLM-only reviews are converging across vendors. "This test FAILS,
here's the output" has a 0% false-positive rate and no competitor at this
price point does it. The PR71 `__dirname` P1 is caught deterministically by
execution — no reasoning required. `codeExecution` is already advertised on
Verify plans; this makes it real.

**Existing scaffolding:** `apps/server/src/runtime-verify.ts`
(`runtimeVerify`, `formatRuntimeEvidence`), the per-review repo checkout
(`checkoutRepoForCodex`), and the plan gate (`plan.codeExecution`).

**Steps**
1. **Audit** what `runtime-verify.ts` does today; keep its API surface.
2. **Sandbox**: run in Docker on the VM — `--network=none`, non-root,
   `--memory 2g --cpus 2`, 5-min hard timeout, tmpfs workdir, zero env/secrets.
   The code under execution is UNTRUSTED (PR authors are adversaries):
   container is the boundary, never the host.
3. **Detect the stack** from the checkout: package manager (lockfile), test
   runner (vitest/jest/node:test/pytest), build step. Start JS/TS-only —
   that's the current customer base; add Python next.
4. **Fast deps**: cache `node_modules` per repo+lockfile-hash so a warm run
   installs in seconds, not minutes.
5. **Targeted execution**: run only tests related to the diff
   (`vitest related <changed files>` / `jest --findRelatedTests`), PLUS any
   NEW test files in the PR (catches collection crashes like PR71), PLUS a
   bare `node --check` / import smoke-test of every changed file.
6. **Evidence → findings**: failing test/collection error becomes a P1/P2
   finding with the actual output attached ("runtime evidence"). These
   findings are UN-DROPPABLE by the verifier (they're proof, not opinion) and
   marked distinctly in the review comment.
7. **Fail-safe**: any sandbox/infra failure → log + skip with a note in the
   summary; NEVER block or slow the LLM review (execution runs concurrently
   with the LLM passes; results merge at the end).
8. **Post-fix verification** (ties into Phase 4): after apply-fix commits, run
   the same targeted tests on the fix commit — "fix verified by tests" badge.

**Done when:** a Verify-tier review on a PR with a failing/crashing test posts
a finding containing the real test output, and the scoreboard shows execution
catching bugs the LLM passes missed.

---

## Phase 3 — Kill the variance: union-across-runs · ~2-3 days

**Why:** different runs surface different valid findings (PR27: panelSlug one
run, SQL-injection the next). The reviewer shouldn't be a lottery ticket.

**Existing:** open findings already persist in `pr_reviews.findings_json` and
carry forward (`mergeFindings` / `stillOpen`); fingerprint dedup exists.

**Steps**
1. **Verify the carry-forward is airtight**: a finding from run 1 that run 2
   doesn't re-find must stay open (not flip-flop), survive verification
   (already-posted findings are not re-verified), and only close via
   `reconcileFixedOnHead` (the code actually changed) or explicit resolve.
   Write tests for the flip-flop and re-drop cases (both were real bugs).
2. ✅ **`@orvex deep` command** (built 2026-07-09/10): 2 extra lens passes
   (removed-behavior on the heavy reasoner + second-opinion on the pass-1
   model) unioning into the open set. Paid-plans only, manual-command only.
   Measured cost (2026-07-10): dual-model deep $0.11–0.33; Verify deep
   (non-pro Luna + DeepSeek + MiniMax) **$0.50 / 433s** on an 11-file-context
   PR. Luna PRO mode rejected: 3× tokens, 499s empty-answer failures, no
   observed quality gain over non-pro.
3. **Single-run recall benchmark — target ≥75%** (protocol, run on each newly
   posted PR before merging): let all competitor bots + one `@orvex deep`
   review the fresh PR (first look, no stored state), verify EVERY bot's
   findings against the actual code (the 2026-07-10 audit process: trace the
   claim, empirically test where possible), build the union of verified-real
   bugs as ground truth, then score Orvex's single run = caught/total.
   ≥75% of verified-real bugs in ONE deep run = pass. Grade precision on the
   same run (false positives / total posted). Baseline to beat, from the
   verified 10-PR audit: CodeRabbit 100%, Qodo 96%, codex 95% precision;
   nobody's single-run recall has been measured yet — being FIRST to publish
   a real recall number is itself marketing ammo.
4. **Deep-vs-normal value proof — deep must EARN its 2× price**: on the same
   fresh PR, run `@orvex review` (normal) first, grade it, then `@orvex deep`
   on the same commit — carry-forward dedup means deep's NEWLY-posted
   findings are exactly its marginal value over normal. Per-pass logs
   (`pass N/5 … +K findings`) give attribution for free. Success criterion:
   across ≥5 PRs, deep's extra passes add verified-real P1/P2 findings on a
   majority of non-trivial PRs (early signal says yes: pass-4/5 contributed
   the FeatureFlag-migration P1, the curl-timeout P2, and PR91's
   removed-behavior bug — all misses of the first 3 passes). If deep only
   ever adds P3/info, cut it to ONE extra pass and reprice.
5. **Measure variance**: re-review the same 5 PRs (one-time, ~$2 total),
   report severe-core overlap % (2026-07-10 3-run sample on PR102: P1/P2
   clusters recurred 3/3 runs; variance confined to info/P3 tail — keep it
   that way as a regression check).

**Done when:** single-run recall ≥75% on verified ground truth, deep
demonstrably adds severe findings over normal on the same PRs, and
re-reviewing never loses a finding.

---

## Phase 4 — Bulletproof apply-fix · ~3-5 days

**Why:** "found a P1, fixed it in one click, tests pass" is the demo that
closes sales — and broken apply-fix is the fastest way to lose trust. You've
personally hit: stuck "Applying fix", silent skips, no live status.

**Steps**
1. **Status lifecycle in comments**: tick checkbox → immediate reply
   "🔄 Applying…" (done) → edit that same reply to "✅ Committed abc1234" or
   "❌ Skipped — <concrete reason>". No state may end without a visible
   terminal message (audit every early-return in `autofix.ts` — each must
   post its reason).
2. **Anchor robustness**: fix application must handle CRLF, relocated lines,
   multi-hunk suggestions, and stale anchors (file changed since review).
   Stale anchor → re-fetch head + re-derive the fix via one MiniMax call
   rather than skipping.
3. **Fixture test-suite**: a set of synthetic PRs (deletion-only file, CRLF
   file, moved code, conflicting later commit) that `pnpm test` applies fixes
   against — apply-fix gets regression tests like any other feature.
4. **Post-apply verify**: `verifyFixes` stays fail-closed; Verify tier also
   runs Phase-2 targeted tests on the fix commit and reports the result in
   the reply.
5. **Batch mode** (`@orvex fix all`): sequential with per-fix status edits, a
   final summary comment, and one commit per fix (revertability).

**Done when:** the fixture suite passes, and 20 consecutive real apply-fix
clicks each end in a visible ✅-or-❌-with-reason (zero silent ends).

---

## Phase 5 — Prove it publicly · ~1 week, after 1-4

1. **Benchmark page** from Phase-1 data: catch-rate table vs named
   competitors, with linkable real examples (PR70's health-probe P1 that
   OpenAI's own reviewer missed is the headline).
2. **Landing page**: lead with runtime proof ("the only reviewer that RUNS
   your PR") + the benchmark. Real screenshots, real P1s, no stock claims.
3. **Feedback loop in-product**: 👍/👎 reactions on every finding (competitors
   have it; it also feeds Phase-1 ground truth automatically).
4. **Onboarding**: install → first review < 5 minutes; a public demo repo
   where anyone can open a PR and watch Orvex review it.
5. ✅ **Pricing** (shipped 2026-07-11): Starter $29 (100 incl, $0.50 overage),
   Pro Unlimited $69, Verify Lite $49 (50 incl), Verify $99 (120 incl, $0.75
   overage), custom plans are handled privately. Deep review = 2 quota units ($1 Starter / $1.50
   Verify over quota). Free: 10 lifetime reviews. Stripe live prices + meters
   configured; old prices archived.
6. **Distribution**: GitHub Marketplace listing, docs site, a launch post
   built on the benchmark.

---

## Phase 6 — Convert the traffic (website + dashboard) · ~2-4 days

**Why:** the product got good, but the marketing page sells on the WRONG axis
(noise-reduction) and hides its strongest asset (the proven catch-rate lead
over CodeRabbit/codex/Qodo). Traffic that arrives isn't being converted.
Design isn't bad — it's under-selling. From the 2026-07-11 conversion audit:

**Quick wins (do first — hours, not days)**
1. **Fix the page `<title>`** — currently the dev leftover "Orvex Review — Site
   & Tenant Dashboard Design." It's the browser tab, Google result, and every
   shared-link preview. Replace with a real outcome+brand title + meta
   description. (Embarrassing; ~2 min.)
2. **A SLOGAN / tagline** — the site has none. Needs one memorable line that
   states the outcome ("Catches the bug that would've shipped" / "The reviewer
   that runs your code" — TBD, test a few). Put it in the hero, the title, OG
   tags, and the GitHub Marketplace listing.
3. **Surface the scoreboard as proof** — the head-to-head catch-rate data
   (Orvex vs CodeRabbit/codex/Qodo, verified) is the single most persuasive
   asset and appears NOWHERE on the site. Add a "how we compare" section with
   real numbers + linkable real-PR examples. This is the #1 conversion lever.

**Higher-effort**
4. **Rework the hero to lead with the OUTCOME**, not the anti-noise angle.
   Buyer's question is "will it catch the bug that ships?" — answer that first;
   keep "no repeated nits / 8 comments max" as the strong secondary
   differentiator, not the headline.
5. **Add social proof** — testimonials, install count, PRs-reviewed /
   bugs-caught counters, GitHub stars, "trusted by" logos. Devs don't install
   review tools without evidence others do. Even in beta, show concrete
   numbers instead of an empty trust section.
6. **Fix CTA + time-to-value story** — "Start free — sign in" is
   self-contradicting and dumps to a bare login. Make the CTA promise the real
   magic: install → first review on your next PR in minutes. Show the 3-step
   getting-started path.
7. **Dashboard first-run activation** — a freshly-installed user sees empty
   tables ("No reviews yet"). Add a prominent **"Review your first PR now"**
   empty-state action (runs `@orvex review` on an existing open PR) — the
   fastest path to the aha moment. Time-to-first-value is the top activation
   lever for dev tools and it's currently left to chance.

**Done when:** title/OG fixed, a slogan is live across surfaces, the catch-rate
comparison is on the page with real examples, the hero leads with outcome +
has social proof, and a new install reaches its first review in one obvious
click from the dashboard.

---

## Phase 7 — Close the greptile gap (competitor fine-tune loop) · ongoing

**Why:** the head-to-head benchmark (2026-07-12, Velatrix-Cloud PRs #114–123)
shows Orvex is competitive but NOT dominant on real bugs. **Greptile is the bar.**

**Benchmark tooling (built, read-only, combinable):**
- `apps/eval/src/bench/competitors.ts` — Orvex vs codex/greptile/coderabbit/qodo/gitar
  on the owner's own PRs. Parses each tool's format (inline comments + Orvex's
  summary-table findings + CodeRabbit review-state), clusters by file+line (±5),
  splits by severity (P1/P2 "bugs" vs all), and reports both/`competitor-only`
  (Orvex MISSED)/`Orvex-only`. Saves each batch to `results/<batch>.json`;
  `--combine` sums across batches. Run on the SERVER (app token, private repo):
  `ORVEX_INSTALL_ID=144378482 tsx apps/eval/src/bench/competitors.ts`.
  ⚠ results/ lives under a synced dir — move it to `orvex-data/` (outside the repo)
  before it gets wiped by a `--restart` deploy, OR pull it to local after each run.
- `apps/eval/src/bench/competitors.ts` results are COVERAGE (who flagged what),
  NOT correctness — a "missed"/"unique" could be a false positive either way.
- `apps/eval/src/bench/{reverse-diff,bench}.ts` — separate ground-truth reversion
  benchmark on public OSS bug-fixes (needs a GitHub PAT via `BENCH_TOKEN`; corpus
  gate + full-file context added; not yet a trustworthy run — see marketing memo).

**Result on batch #114–123 (P1/P2 bugs only):**

| Orvex vs | reviewed | both | Orvex MISSED | Orvex-only |
|----------|----------|------|--------------|------------|
| greptile | 10/10 | 6 | **10** | 7 |
| codex | 6/10* | 4 | 6 | 9 |
| qodo | 10/10 | 7 | 6 | 6 |
| gitar | 10/10 | 3 | 3 | 10 |
| coderabbit | 7/10 | 3 | 1 | 5 |

(*codex only posts when it finds something, so its true coverage is unknown.)
Orvex's raw "unique" lead on ALL findings (16–19) is inflated by INFO/test-coverage
notes competitors correctly skip — the P1/P2 view above is the honest signal.

**Gap analysis — what greptile catches that Orvex misses (all one class):**
cross-function **dataflow / state-tracking** bugs, not single-hunk bugs.
- resource-not-released-on-failure (PR#118 Stripe coupon/reservation leak on failed checkout)
- asymmetric error path (PR#121 xtream failures not recorded under the tenant guard)
- state-machine edge (PR#119 legacy chargeback blocks webhooks)
- dead-check-after-refactor (PR#123 cross-tenant ownership check became dead code)
- post-transform consistency (PR#123 imported EPG descriptions stay null)

**The fine-tune loop (measurable, gates on the benchmark) — re-ordered after a
Codex architecture review (2026-07-12). Codex's factual reading was accurate
(context IS fixed-limit single-hop in repo-context.ts; the codex sandbox bypass
is real but the server is an externally-sandboxed VM). Its plan is right about
Greptile's LONG-TERM moat but over-scoped and mis-ordered for THIS gap — it bets
60% on a persistent code graph before anyone has diagnosed the misses. Sequence
cheap-and-measured first; reach for the big architecture only if the data demands
it.**

1. **Diagnose FIRST (gates everything)** — determine, for the greptile misses
   (PR#118 payment.js coupon/reservation leak; PR#121 xtream failures not recorded),
   whether Orvex's models RAISED them and the verifier/noise/confidence filter
   DROPPED them (→ recall-tuning fix, ~5% of the effort) or NEVER found them (→
   rules/prompt + context depth). Free: read the real worker logs for those reviews
   (`verification dropped … / noise filter dropped … / confidence filter dropped …`)
   and, if needed, re-review offline via `apps/eval` capturing pre- vs post-verifier
   findings. ← IMMEDIATE NEXT STEP.
2. **Adjudicated benchmark (Codex #3 — promote to near-top).** `competitors.ts`
   measures COVERAGE, not correctness, so it can't prove improvement. Build a
   human-verified gold set: each confirmed miss becomes a permanent regression case
   (`apps/eval/src/cases.ts`, shouldFlag) with held-out repos; track recall by bug
   category + precision/action-rate. Use greptile findings as CANDIDATES to
   adjudicate, never auto-truth. An LLM judge pass over disputed clusters bootstraps
   this. This is the measurement backbone — without it every change below is
   unfalsifiable.
3. **Cheap recall fixes (do after diagnosis points the lever):**
   - if verifier-drop → loosen the strict verifier for multi-step-reasoning findings
     (the 4 classes are exactly the "can't re-derive in one step" kind it over-prunes).
   - deepen context → include the FULL changed-function body + immediate callers
     (raise/rework repo-context.ts limits), not just the diff hunk, so cross-function
     dataflow is visible. Most greptile misses live inside the changed function or its
     direct callers — a full graph is NOT required to see them.
   - add hunting rules for the 4 classes (asymmetric-error-path, resource-leak-on-
     failure, dead-check-after-change, post-transform-null) in `rules/orvex-rules.md`
     + `prompt.ts`. Re-run offline eval after each change; re-run `competitors.ts` on
     #114–123 and watch "greptile-only (Orvex missed)" fall from 10.

**Only if step 3 plateaus — the big architecture (Codex #1/#2, LONG-TERM, weeks+):**
- **Persistent code graph** — incremental symbol/caller/callee/route/ORM/test graph,
  replacing per-review one-hop retrieval. Greptile's real moat. Defer until the
  diagnosis proves the residual misses genuinely need cross-file graph reasoning.
- **Adaptive investigation controller** — generalize the existing Codex agentic pass
  (codex-cli.ts) into a hypothesis-driven recursive search that follows callers/data
  flow and stops only when each finding has a demonstrated failure path. Incremental
  upgrade to what exists, not a from-scratch rebuild.

**Separate tracks (valid, but NOT what closes the greptile bug-recall gap):**
- **Harden agent execution (Codex security note)** — the codex sandbox bypass relies
  on the VM being the sandbox; for multi-tenant untrusted code, move agents into
  genuinely disposable, network-controlled envs. Own task, not urgent.
- **Tenant-specific learning (Codex #4)** — learn suppressions / accepted findings /
  severity tolerance from team feedback (beyond `@orvex ignore`). Noise-reduction &
  personalization roadmap; orthogonal to catching the missed bugs.
- **Per-review test-generation envs (Codex #5)** — a moonshot; the current misses are
  static-reasoning bugs needing no execution. Defer hard; runtime proof (Phase 2)
  already covers regression-style verification.

**Investment reality check:** Codex proposed 60% graph+controller / 25% eval+learning
/ 15% models. Counter: spend the first ~$50 + a day on diagnosis (step 1) and the
adjudicated harness (step 2); do the cheap recall fixes (step 3); re-measure. Decide
the 60% graph bet with data, not before it.

---

## Cross-cutting (ongoing)

- **Multi-repo validation**: everything above is validated on ONE JS repo.
  Before GA, run the pipeline against 2-3 OSS repos in other stacks
  (Python/Go) — free to review own forks; fix what breaks.
- **Ops guardrails** (mostly done): codex-auth 🚨 alert, immutable
  secrets, cost ceilings per tier, `/ready` monitoring. Add: daily digest
  (reviews run, findings, cost, codex health) to email/Discord.
- **The scoreboard gates every change**: no prompt/pipeline change ships
  without a before/after scoreboard delta.
- **Anti-abuse / trial protection** (SHIPPED 2026-07-13, plus deferred items):
  In place now — per-GitHub-owner 10-review trial cap; per-IP multi-account
  block (≥5 accounts/IP/24h); global free-tier daily spend circuit-breaker
  (`ORVEX_FREE_TIER_DAILY_CAP`, bounds $ damage regardless of identity evasion);
  email-alias collapse (`normalizeEmail`: gmail dots/+tags → one identity);
  disposable-inbox block (`isDisposableEmail`); cross-provider normalized-email
  dedup; unique GitHub/Google identity constraints.
  **Deferred, for later (deliberate tradeoffs, not oversights):**
  1. **Email verification on signup** — genuinely useful friction, but there is
     NO email-sending infra (no SendGrid/SMTP/Resend). It is a real prerequisite
     to build, not a quick add. Set up transactional email before scale, then
     require verifying the address before the trial activates.
  2. **Per-GitHub-user trial aggregation** ("one trial per human across all their
     orgs") — closes free-org farming, but hits legit multi-org users (personal +
     work, agencies) and needs a reliable install→user link (webhook reviews
     often have no logged-in identity). Do once traffic is worth farming; the
     spend cap covers the damage until then.
  3. **GitHub account-age signal at install** — a brand-new GitHub account is a
     farm signal; add as a LOGGED signal (not a hard block — false-positives on
     legit new devs) once there's abuse to tune against.
  4. **$1 card trial** — most effective anti-abuse, but would cut real signups
     60–80% and every competitor is no-card; wrong trade pre-launch. Keep the
     card at the UPGRADE step; revisit only once demand exists.

## Suggested order & rough timeline

| Week | Work |
|------|------|
| 1 | Phase 1 scoreboard + first miss-pattern fixes |
| 2-3 | Phase 2 runtime execution MVP (JS/TS) + Phase 3 variance fixes (small, parallel) |
| 3-4 | Phase 4 apply-fix hardening + fixture suite |
| 4-5 | Phase 5 benchmark page, onboarding, pricing, launch |

Total: ~a month to a provably-differentiated product with published evidence.
