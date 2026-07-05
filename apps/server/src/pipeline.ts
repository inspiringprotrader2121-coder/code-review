import {
  buildRepoContext,
  createInstallationOctokit,
  createCheckRun,
  fetchFileContent,
  fetchPrDiff,
  fetchPrLabels,
  fetchPullRequest,
  fetchRepoFile,
  hasIgnoreLabel,
  isPrStillOpen,
  isRepoAllowed,
  loadGitHubConfigFromEnv,
  postPullRequestReview,
  replyToReviewComment,
  shouldSkipPr,
  type GitHubAppConfig,
  type InlineReviewComment,
} from '@orvex-review/github';
import type { ReviewJobPayload } from '@orvex-review/queue';
import {
  auditFindingsFromContent,
  parseReviewConfigYaml,
  runSemgrepOnPaths,
  shouldIgnorePath,
  type ReviewConfig,
} from '@orvex-review/rules';
import {
  commandTrigger,
  dedupeByFileLine,
  filterAndCapFindings,
  fingerprintFinding,
  formatFixedReply,
  formatInlineFinding,
  formatReviewBody,
  llmFindingsToReviewFindings,
  isTransientLlmError,
  REVIEW_INCOMPLETE_SUMMARY,
  mergeFindings,
  reconcileFixedOnHead,
  dropSelfNegatingFindings,
  runLlmReview,
  toStoredFinding,
  verifyFindings,
  type ReviewFinding,
} from '@orvex-review/review';
import {
  createAppDatabase,
  type AppDatabase,
  type PrReviewState,
  type StoredFinding,
} from '@orvex-review/store';
import { planFeatures } from '@orvex-review/tenants';
import { runtimeVerify, formatRuntimeEvidence } from './runtime-verify.js';

export interface LlmTarget {
  apiKey: string;
  /** set for OpenAI-compatible providers (MiniMax, z.ai/GLM); unset means Anthropic */
  baseUrl?: string;
  model: string;
}

export interface WorkerConfig {
  github: GitHubAppConfig;
  llmApiKey: string;
  /** set for OpenAI-compatible providers (MiniMax); unset means Anthropic */
  llmBaseUrl?: string;
  llmModel: string;
  /** the cheaper 'standard' model (MiniMax) for Review/Free tiers; falls back to
   *  the premium model when ORVEX_STANDARD_* is not configured. */
  standardModel: LlmTarget;
  maxFileBytes: number;
  maxFiles: number;
  enableCheckRuns: boolean;
  store: AppDatabase;
}

type ModelTier = 'premium' | 'standard' | 'hybrid';
export type PassTier = 'premium' | 'standard';

function premiumTarget(config: WorkerConfig): LlmTarget {
  return { apiKey: config.llmApiKey, baseUrl: config.llmBaseUrl, model: config.llmModel };
}

/** The model + cost-tier for a given review PASS. 'hybrid' tiers run pass 1
 *  (general) on the standard model (MiniMax) and pass 2+ (deep-dive) on the
 *  flagship (GLM-5.2) — two different models for broader bug coverage. */
export function modelForPass(
  config: WorkerConfig,
  plan: { modelTier?: ModelTier },
  passIndex: number,
): { target: LlmTarget; tier: PassTier } {
  if (plan.modelTier === 'hybrid') {
    return passIndex === 0
      ? { target: config.standardModel, tier: 'standard' }
      : { target: premiumTarget(config), tier: 'premium' };
  }
  if (plan.modelTier === 'standard') return { target: config.standardModel, tier: 'standard' };
  return { target: premiumTarget(config), tier: 'premium' };
}

/** The model for non-pass LLM work (the verification pass). Hybrid uses the
 *  flagship for verification. */
export function modelForPlan(config: WorkerConfig, plan: { modelTier?: ModelTier }): LlmTarget {
  if (plan.modelTier === 'standard') return config.standardModel;
  return premiumTarget(config);
}

let sharedStore: AppDatabase | null = null;

export function loadWorkerConfig(): WorkerConfig {
  const github = loadGitHubConfigFromEnv();

  // MiniMax (OpenAI-compatible) takes precedence when configured; Anthropic otherwise.
  const minimaxKey = process.env.MINIMAX_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!minimaxKey && !anthropicKey) {
    throw new Error('MINIMAX_API_KEY or ANTHROPIC_API_KEY is required');
  }

  if (!sharedStore) {
    sharedStore = createAppDatabase();
  }

  const premiumApiKey = (minimaxKey ?? anthropicKey)!;
  const premiumBaseUrl = minimaxKey ? (process.env.MINIMAX_BASE_URL ?? 'https://api.minimax.io/v1') : undefined;
  const premiumModel = minimaxKey
    ? (process.env.MINIMAX_MODEL ?? 'MiniMax-M3')
    : (process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-20250514');

  // The cheaper 'standard' model (Review/Free). Configured via ORVEX_STANDARD_*;
  // if unset, falls back to the premium model so nothing breaks.
  const stdKey = process.env.ORVEX_STANDARD_API_KEY;
  const standardModel: LlmTarget = stdKey
    ? {
        apiKey: stdKey,
        baseUrl: process.env.ORVEX_STANDARD_BASE_URL,
        model: process.env.ORVEX_STANDARD_MODEL ?? 'MiniMax-M3',
      }
    : { apiKey: premiumApiKey, baseUrl: premiumBaseUrl, model: premiumModel };

  return {
    github,
    llmApiKey: premiumApiKey,
    llmBaseUrl: premiumBaseUrl,
    llmModel: premiumModel,
    standardModel,
    maxFileBytes: Number(process.env.MAX_FILE_BYTES ?? 300_000),
    maxFiles: Number(process.env.MAX_FILES ?? 150),
    enableCheckRuns: process.env.CHECK_RUNS_ENABLED === '1',
    store: sharedStore,
  };
}

export interface ProcessResult {
  findingCount: number;
  newCount: number;
  fixedCount: number;
  reviewId?: number;
  skipReason?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

// LLM cost model (USD per 1M tokens), PER MODEL TIER — a Review (MiniMax) review
// must not be costed at Verify (GLM-5.2) rates. Premium defaults to GLM-5.2
// pricing, standard to MiniMax-M3; override via env if you switch providers.
const PREMIUM_COST_IN = Number(process.env.ORVEX_COST_INPUT_PER_M ?? 1.4);
const PREMIUM_COST_OUT = Number(process.env.ORVEX_COST_OUTPUT_PER_M ?? 4.4);
const STANDARD_COST_IN = Number(process.env.ORVEX_STANDARD_COST_INPUT_PER_M ?? 0.3);
const STANDARD_COST_OUT = Number(process.env.ORVEX_STANDARD_COST_OUTPUT_PER_M ?? 1.2);
function computeCostUsd(inputTokens: number, outputTokens: number, tier: 'premium' | 'standard'): number {
  const [inRate, outRate] = tier === 'standard' ? [STANDARD_COST_IN, STANDARD_COST_OUT] : [PREMIUM_COST_IN, PREMIUM_COST_OUT];
  return (inputTokens / 1e6) * inRate + (outputTokens / 1e6) * outRate;
}

/** Total tokens + cost from per-tier usage (a hybrid review mixes two models,
 *  each with its own $/token). */
function totalUsage(usage: { standard: { in: number; out: number }; premium: { in: number; out: number } }): {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
} {
  return {
    inputTokens: usage.standard.in + usage.premium.in,
    outputTokens: usage.standard.out + usage.premium.out,
    costUsd:
      computeCostUsd(usage.standard.in, usage.standard.out, 'standard') +
      computeCostUsd(usage.premium.in, usage.premium.out, 'premium'),
  };
}

/** Run async tasks with a bounded concurrency limit, preserving input order.
 *  Used to fan out review passes + sweep batches so a deep Verify review runs in
 *  parallel instead of sequentially — same coverage, a fraction of the wall time. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

const MS_PER_30_DAYS = 30 * 24 * 3_600_000;

/**
 * Which account limit (if any) this GitHub account has hit. SYNCHRONOUS on
 * purpose — better-sqlite3 counts run with no await, so the caller can pair this
 * with startReviewRun to reserve the slot atomically (no concurrent-burst leak).
 * Counts running + completed reviews so in-flight reviews see each other.
 * Checked cheapest/most-specific first: hourly burst, then monthly cost
 * exposure, then the free-trial lifetime cap.
 */
export function accountLimitReason(
  store: WorkerConfig['store'],
  owner: string,
  plan: ReturnType<typeof planFeatures>,
): 'rate_limited' | 'monthly_limit' | 'trial_exhausted' | null {
  if (
    plan.reviewsPerHour !== null &&
    store.countAccountReviews(owner, { sinceMs: 3_600_000 }) >= plan.reviewsPerHour
  ) {
    return 'rate_limited';
  }
  if (
    plan.reviewsPerMonth !== null &&
    store.countAccountReviews(owner, { sinceMs: MS_PER_30_DAYS }) >= plan.reviewsPerMonth
  ) {
    return 'monthly_limit';
  }
  if (plan.trialReviewLimit !== null && store.countAccountReviews(owner) >= plan.trialReviewLimit) {
    return 'trial_exhausted';
  }
  return null;
}

/** Post the upgrade nudge for a blocked free-tier review (best-effort). */
async function postLimitNudge(
  config: WorkerConfig,
  job: ReviewJobPayload,
  plan: ReturnType<typeof planFeatures>,
  reason: 'rate_limited' | 'monthly_limit' | 'trial_exhausted',
): Promise<void> {
  // Paid tiers have a generous SAFETY ceiling (not a trial), so the message
  // differs from the free-trial upsell wording.
  const body =
    reason === 'rate_limited'
      ? plan.id === 'free'
        ? `⏳ **Orvex free trial** is limited to ${plan.reviewsPerHour} reviews per hour. This push wasn't reviewed — push again later, or [upgrade](https://useorvex.com/pricing) for unlimited reviews.`
        : `⏳ **Orvex safety limit reached** — ${plan.reviewsPerHour} reviews/hour on the ${plan.label} plan (this protects against runaway usage, e.g. a restart loop or misfiring webhook). This push wasn't reviewed; it'll pick up on the next push once the hour rolls over. Contact support if you need a higher limit.`
      : reason === 'monthly_limit'
        ? `⚠️ **Orvex monthly safety limit reached** — ${plan.reviewsPerMonth} reviews in the last 30 days on the ${plan.label} plan. This is a very high threshold real usage shouldn't hit; if you're seeing this, [contact support](https://useorvex.com/pricing) — we'll raise it for genuine usage.`
        : `⚠️ **Orvex free trial used up.** This GitHub account has used all ${plan.trialReviewLimit} free reviews. [Upgrade](https://useorvex.com/pricing) to keep Orvex reviewing your pull requests.`;
  try {
    const octokit = createInstallationOctokit(config.github, job.installationId);
    await octokit.rest.issues.createComment({ owner: job.owner, repo: job.repo, issue_number: job.pr, body });
    console.log(`[worker] ${reason} ${job.owner} (plan=${plan.id})`);
  } catch {
    /* nudge is best-effort */
  }
}

export async function processReviewJob(
  job: ReviewJobPayload,
  config: WorkerConfig,
): Promise<ProcessResult> {
  const startedAt = Date.now();
  const runBase = {
    tenantId: job.tenantId,
    installationId: job.installationId,
    owner: job.owner,
    repo: job.repo,
    pr: job.pr,
    headSha: job.headSha,
    action: job.action,
  };

  // Cooldown on COMMAND/MANUAL re-review of an unchanged commit — `@orvex review`
  // or a manual API call bypasses the automatic SHA dedup BY DESIGN (so a human
  // can force a fresh look), but with no floor at all, the same expensive review
  // can be re-run back-to-back indefinitely. A new push always gets a new SHA and
  // is completely unaffected by this; only re-running an ALREADY-completed review
  // of the SAME commit is throttled.
  if (job.action === 'command' || job.action === 'manual') {
    const cooldownS = Number(process.env.ORVEX_REVIEW_COOLDOWN_S ?? 120);
    const sinceS = config.store.secondsSinceLastCompletedReview(
      job.installationId,
      job.owner,
      job.repo,
      job.pr,
      job.headSha,
    );
    if (sinceS !== null && sinceS < cooldownS) {
      const waitS = cooldownS - sinceS;
      config.store.recordReviewRun({ ...runBase, status: 'skipped', skipReason: 'review_cooldown', durationMs: 0 });
      try {
        const octokit = createInstallationOctokit(config.github, job.installationId);
        await octokit.rest.issues.createComment({
          owner: job.owner,
          repo: job.repo,
          issue_number: job.pr,
          body: `⏳ This commit was already reviewed ${sinceS}s ago — re-running now would just repeat it. Try again in ~${waitS}s, or push a new commit for a fresh review.`,
        });
      } catch {
        /* best-effort */
      }
      console.log(`[worker] cooldown: ${job.owner}/${job.repo}#${job.pr}@${job.headSha.slice(0, 7)} reviewed ${sinceS}s ago (<${cooldownS}s)`);
      return { findingCount: 0, newCount: 0, fixedCount: 0, skipReason: 'review_cooldown' };
    }
  }

  // Free-tier limits, checked and RESERVED atomically: count in-flight + done
  // reviews for the account, and — if allowed — create the 'running' row with NO
  // await in between. Because better-sqlite3 is synchronous, two concurrent
  // reviews on different PRs can't both read a stale count and slip past the cap.
  const plan = planFeatures(config.store.getTenantPlan(job.tenantId));
  if (plan.trialReviewLimit !== null || plan.reviewsPerHour !== null) {
    const reason = accountLimitReason(config.store, job.owner, plan);
    if (reason) {
      config.store.recordReviewRun({ ...runBase, status: 'skipped', skipReason: reason, durationMs: 0 });
      await postLimitNudge(config, job, plan, reason);
      return { findingCount: 0, newCount: 0, fixedCount: 0, skipReason: reason };
    }
  }

  // Insert a 'running' row up front so the dashboard shows the run the instant
  // it's triggered, then finalize the same row when it finishes.
  const runId = config.store.startReviewRun(runBase);

  try {
    const result = await executeReview(job, config);
    config.store.completeReviewRun(runId, {
      status: result.skipReason ? 'skipped' : 'completed',
      skipReason: result.skipReason,
      durationMs: Date.now() - startedAt,
      findingsNew: result.newCount,
      findingsFixed: result.fixedCount,
      findingsOpen: result.findingCount,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      costUsd: result.costUsd,
    });
    return result;
  } catch (err) {
    config.store.completeReviewRun(runId, {
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startedAt,
    });
    throw err;
  }
}

async function executeReview(
  job: ReviewJobPayload,
  config: WorkerConfig,
): Promise<ProcessResult> {
  const { installationId, tenantId, owner, repo, pr: number, action } = job;
  const ref = { owner, repo, number };

  if (config.github.allowedRepo && !isRepoAllowed(owner, repo, config.github.allowedRepo)) {
    throw new Error(`Repo ${owner}/${repo} not in GITHUB_ALLOWED_REPO allowlist`);
  }

  const installation = config.store.getInstallation(installationId);
  if (!installation || installation.suspendedAt) {
    throw new Error(`Installation ${installationId} not active`);
  }

  // The tenant's plan drives review DEPTH and which features run — this is the
  // enforced separation between tiers (Free/Review/Verify), not just wording.
  const plan = planFeatures(config.store.getTenantPlan(tenantId));
  // Review/Free run on the cheaper 'standard' model; Verify/Enterprise on the
  // flagship. Same pipeline — the review call and the verification pass both use
  // the plan's model.
  const llm = modelForPlan(config, plan);
  console.log(`[worker] plan=${plan.id} model=${llm.model}`);

  console.log(
    `[worker] tenant=${tenantId.slice(0, 8)} inst=${installationId} account=${installation.accountLogin} plan=${plan.id}`,
  );

  const octokit = createInstallationOctokit(config.github, installationId);
  // (Free-tier trial/hourly limits are enforced up front in processReviewJob,
  // before this review is even recorded, so they reserve the slot atomically.)

  const pr = await fetchPullRequest(octokit, ref);
  const effectiveSha = pr.headSha;

  const labels = await fetchPrLabels(octokit, ref);
  const repoConfigYaml =
    (await fetchRepoFile(octokit, owner, repo, '.orvex-review.yml', effectiveSha)) ??
    // deprecated pre-rename config filename; remove after customers migrate
    (await fetchRepoFile(octokit, owner, repo, '.velatrix-review.yml', effectiveSha));
  const reviewConfig = parseReviewConfigYaml(repoConfigYaml);

  if (hasIgnoreLabel(labels, reviewConfig.ignore_labels)) {
    console.log(`[worker] skip PR #${number}: label ${reviewConfig.ignore_labels.join('/')}`);
    return { findingCount: 0, newCount: 0, fixedCount: 0, skipReason: 'ignore_label' };
  }

  const skipReason = shouldSkipPr(pr, { botLogin: config.github.botLogin });
  if (skipReason) {
    console.log(`[worker] skip PR #${number}: ${skipReason}`);
    return { findingCount: 0, newCount: 0, fixedCount: 0, skipReason };
  }

  const priorState = config.store.getState({ installationId, owner, repo, pr: number });
  const sinceSha =
    action === 'synchronize' && priorState?.lastSha ? priorState.lastSha : undefined;

  const files = await fetchPrDiff(octokit, ref, {
    maxFileBytes: config.maxFileBytes,
    maxFiles: config.maxFiles,
    ignoreGlobs: reviewConfig.ignore,
    sinceSha,
    headSha: effectiveSha,
  });

  console.log(
    `[worker] PR #${number} @ ${effectiveSha.slice(0, 7)} action=${action} files=${files.length}` +
      (sinceSha ? ` incremental ${sinceSha.slice(0, 7)}..${effectiveSha.slice(0, 7)}` : ' full diff'),
  );

  const fileReader = {
    readFile: (path: string, ref: string) =>
      fetchFileContent(octokit, owner, repo, path, ref),
  };

  const priorOpen = (priorState?.findings ?? []).filter((f) => f.status === 'open');
  const { stillOpen: verifiedOpen, newlyFixed: verifiedFixed } = await reconcileFixedOnHead(
    priorOpen,
    effectiveSha,
    fileReader,
  );

  for (const fixed of verifiedFixed) {
    if (fixed.githubCommentId) {
      try {
        await replyToReviewComment(
          octokit,
          owner,
          repo,
          number,
          fixed.githubCommentId,
          formatFixedReply(effectiveSha),
        );
      } catch (err) {
        console.warn(`[worker] could not reply on comment ${fixed.githubCommentId}:`, err);
      }
    }
  }

  const ruleFindings = await runDeterministicRules(
    octokit,
    owner,
    repo,
    effectiveSha,
    files,
    reviewConfig,
  );

  const filesForLlm = files.filter((f) => {
    // Every changed file with a patch gets the deep LLM review. (Previously a
    // file was SKIPPED once semgrep flagged it — that silently dropped LLM
    // review on exactly the files most likely to have deeper bugs. Semgrep
    // findings are additive, not a replacement for the model's review.)
    return Boolean(f.patch) && f.status !== 'removed';
  });

  let llmSummary: string | undefined;
  let llmFindings: ReviewFinding[] = [];
  // Token usage per model tier — a hybrid review runs two different models, so
  // cost is tracked separately (each has its own $/token) and summed.
  const usage = { standard: { in: 0, out: 0 }, premium: { in: 0, out: 0 } };
  const onUsageFor = (tier: PassTier) => (u: { inputTokens: number; outputTokens: number }) => {
    usage[tier].in += u.inputTokens;
    usage[tier].out += u.outputTokens;
  };
  // full-file contents used by both the review call and the verification pass
  let reviewContextFiles: Array<{ path: string; content: string }> = [];

  // author intent — critical for not flagging deliberate changes as bugs
  const prIntent = [pr.title, pr.body].filter(Boolean).join('\n\n').slice(0, 4000);

  if (filesForLlm.length > 0) {
    // Deep context: repo tree + files the changed code imports, so the model
    // can reason across files instead of judging hunks blind. ORVEX_DEEP_CONTEXT=0 disables.
    let reviewContext: Awaited<ReturnType<typeof buildRepoContext>> | undefined;
    if (process.env.ORVEX_DEEP_CONTEXT !== '0') {
      try {
        reviewContext = await buildRepoContext(
          octokit,
          owner,
          repo,
          effectiveSha,
          filesForLlm.map((f) => f.filename),
          // Deep context: every changed file in full + the import/dependency
          // neighborhood (the high-value cross-file signal), plus a modest slice
          // of the rest of the repo. All env-tunable — raising ORVEX_CTX_OTHERS
          // toward "whole repo" trades latency/cost for coverage (200 files ≈
          // an 11-minute review with reasoning on, which does not scale across
          // tenants), so the default keeps reviews to a few minutes.
          {
            maxSourceFiles: Number(process.env.ORVEX_CTX_SOURCE ?? 200),
            maxRelated: Number(process.env.ORVEX_CTX_RELATED ?? 18),
            maxDependents: Number(process.env.ORVEX_CTX_DEPENDENTS ?? 12),
            // Per-file cap raised so LARGE changed files are shown in FULL — a
            // bug past the old 32k cutoff (e.g. line 1600+ of a big file) was
            // invisible to the model. GLM-5.2's 1M window has room.
            maxFileBytes: Number(process.env.ORVEX_CTX_FILE_BYTES ?? 250_000),
            // Pull in enough of the rest of the repo to feed the whole-repo
            // sweep below (it batches these files); ORVEX_REPO_SWEEP_MAX_FILES
            // controls how deep the sweep goes.
            // Plan-driven: retrieve top-K relevant files for the passes (all
            // tiers), plus extra files only for the Verify whole-repo sweep.
            maxOthers: plan.retrievalTopK + (plan.repoSweep ? plan.sweepMaxFiles : 0),
          },
        );
        console.log(
          `[worker] deep context: ${reviewContext.changedContents.length} full files, ` +
            `${reviewContext.related.length} imports, ${reviewContext.dependents.length} dependents, ` +
            `${reviewContext.others.length} index-retrieved relevant files, tree=${reviewContext.treePaths.length}`,
        );
        reviewContextFiles = [
          ...reviewContext.changedContents,
          ...reviewContext.related,
          ...reviewContext.dependents,
          ...reviewContext.others,
        ];
      } catch (err) {
        console.warn('[worker] deep context unavailable, reviewing diff-only:', err);
      }
    }

    // Depth is enforced HERE, in the harness, and scaled BY PLAN — not left to
    // how long one model call decides to think. Higher tiers get more passes and
    // (Verify only) an exhaustive whole-repo sweep. Findings accumulate and
    // dedupe by fingerprint; a hard call-count cap prevents runaway.
    const baseCtx = { ...(reviewContext ?? {}), prTitle: pr.title, prBody: pr.body };
    const runReview = (ctx: typeof baseCtx, target: LlmTarget, tier: PassTier) =>
      runLlmReview(filesForLlm, {
        apiKey: target.apiKey,
        baseUrl: target.baseUrl,
        model: target.model,
        context: ctx,
        onUsage: onUsageFor(tier),
      });

    const passes = Math.max(1, plan.reviewPasses);
    // Tuned so a Verify review is a genuinely deep ~10 minutes (not a 3-minute
    // burst that's indistinguishable from the base tier): more calls, deeper
    // per-file sweep reads (below), and MODERATE concurrency so the work spreads
    // out rather than finishing all at once. Review has few calls, so a lower
    // concurrency barely affects it — this mainly paces the many-call Verify tier.
    const maxCalls = Math.max(passes, Number(process.env.ORVEX_REVIEW_MAX_CALLS ?? 28));
    const concurrency = Math.max(1, Number(process.env.ORVEX_REVIEW_CONCURRENCY ?? 3));
    const accumulated: ReviewFinding[] = [];

    // Build the full list of review calls up front — N passes over the change +
    // its neighborhood + top-K index files, plus (Verify only) whole-repo sweep
    // batches over the rest — then run them all with BOUNDED CONCURRENCY. Same
    // coverage as before, but parallel instead of sequential, so a deep review
    // finishes in a fraction of the wall-clock.
    const passOthers = (reviewContext?.others ?? []).slice(0, plan.retrievalTopK);
    const passCtx = { ...baseCtx, others: passOthers };

    // Verify's 2nd+ passes are a DEEP-DIVE with a different lens — the first pass
    // reviews generally, later passes hunt SPECIFICALLY for the subtle high-impact
    // bugs a first read misses. Different focus (not a redundant re-run) is what
    // makes multiple passes catch meaningfully more (e.g. the data-integrity /
    // migration bugs a general pass skims over).
    const DEEP_DIVE_FOCUS =
      'This is a SECOND, DEEPER review pass — a general pass already ran. Re-read the changed code with fresh skepticism and hunt SPECIFICALLY for the subtle, high-impact defects a first read misses:\n' +
      '- DATA INTEGRITY & MIGRATIONS: type mismatches (e.g. copying VARCHAR/UUID ids into a BIGINT column), count-based logic that can DROP or DUPLICATE rows, partial-failure / retry paths that re-run destructively, missing idempotency or version/marker guards, dropping backups before reconciling.\n' +
      '- SECURITY: auth/authz gaps, injection, IDOR, secrets, fail-OPEN defaults, signing/verification mistakes.\n' +
      '- CONCURRENCY: races, TOCTOU, non-atomic read-modify-write, lost updates.\n' +
      '- EDGE CASES: null/empty/boundary/malformed input, off-by-one, error paths, tests whose assertions no longer match the code they test.\n' +
      'Report anything real the first pass would plausibly have overlooked. Do not repeat obvious findings; go deeper.';
    const deepDiveCtx = { ...passCtx, extraFocus: DEEP_DIVE_FOCUS };

    type ReviewCall = {
      label: string;
      kind: 'pass' | 'sweep';
      ctx: typeof baseCtx;
      target: LlmTarget;
      tier: PassTier;
    };
    const reviewCalls: ReviewCall[] = [];
    for (let p = 0; p < passes; p++) {
      const { target, tier } = modelForPass(config, plan, p);
      reviewCalls.push({
        label: `pass ${p + 1}/${passes}${p >= 1 ? ' (deep-dive)' : ''} [${target.model}]`,
        kind: 'pass',
        ctx: p >= 1 ? deepDiveCtx : passCtx,
        target,
        tier,
      });
    }

    // Sweep batches: pack MANY files per call (each clipped smaller — the sweep is
    // for breadth/cross-file interactions, not deep-reading every file), so 100
    // files become a handful of calls instead of ~100.
    const sweepSource = plan.repoSweep ? (reviewContext?.others ?? []).slice(plan.retrievalTopK) : [];
    if (sweepSource.length > 0) {
      const budget = Number(process.env.ORVEX_MAX_OTHER_CHARS ?? 45_000) - 2_000;
      // Read a meaningful chunk of each swept file (deeper than a skim) so the
      // Verify sweep is thorough, not just broad. ~4 files/batch at this size.
      const perFile = Number(process.env.ORVEX_SWEEP_FILE_CHARS ?? 10_000);
      let batch: Array<{ path: string; content: string }> = [];
      let used = 0;
      const pushBatch = () => {
        if (batch.length === 0) return;
        const files = batch;
        reviewCalls.push({
          label: `sweep (${files.length}f)`,
          kind: 'sweep',
          ctx: { ...baseCtx, related: [], dependents: [], others: files },
          target: premiumTarget(config),
          tier: 'premium',
        });
        batch = [];
        used = 0;
      };
      for (const f of sweepSource) {
        const content = f.content.length > perFile ? `${f.content.slice(0, perFile)}\n… (truncated)` : f.content;
        if (used + content.length > budget && batch.length > 0) pushBatch();
        batch.push({ path: f.path, content });
        used += content.length;
      }
      pushBatch();
    }

    const toRun = reviewCalls.slice(0, maxCalls);
    console.log(`[worker] deep review: ${toRun.length} calls (${passes} passes + ${toRun.length - passes} sweep), concurrency=${concurrency}`);

    // Mid-run abort: a Verify review can run ~10 minutes across many calls — if
    // the PR closes/merges partway through (the real incident this fixes: a
    // backlog job finishing a full expensive review on a PR closed minutes into
    // the run), stop starting NEW calls and skip posting entirely. Calls already
    // in flight finish naturally (aborting a live HTTP request mid-stream isn't
    // worth the added risk); checking before every new call is what stops the
    // bulk of the remaining work. Best-effort: a failed check never itself
    // aborts the review.
    let prClosedMidRun = false;
    const abortPollMs = Math.max(5_000, Number(process.env.ORVEX_ABORT_POLL_MS ?? 45_000));
    const abortPoll = setInterval(() => {
      isPrStillOpen(octokit, ref)
        .then((open) => {
          if (!open && !prClosedMidRun) {
            prClosedMidRun = true;
            console.warn(`[worker] PR #${number} closed mid-review — stopping further model calls`);
          }
        })
        .catch(() => {});
    }, abortPollMs);

    let outcomes: Array<{
      ok: boolean;
      transient: boolean;
      degraded: boolean;
      summary: string | undefined;
      findings: ReviewFinding[];
      kind: 'pass' | 'sweep';
    }>;
    try {
      outcomes = await mapLimit(toRun, concurrency, async (call) => {
        if (prClosedMidRun) {
          return { ok: false, transient: false, degraded: false, summary: undefined, findings: [], kind: call.kind };
        }
        try {
          const llm = await runReview(call.ctx, call.target, call.tier);
          const got = llmFindingsToReviewFindings(llm.findings);
          // A call that returned the "unparseable" sentinel with no findings
          // didn't really succeed — it degraded. Mark it NOT-ok so an all-degraded
          // review fails/retries instead of posting a contradictory clean pass.
          const degraded = got.length === 0 && llm.summary === REVIEW_INCOMPLETE_SUMMARY;
          console.log(`[worker] ${call.label}: +${got.length} findings${degraded ? ' (degraded/unparseable)' : ''}`);
          return { ok: !degraded, transient: false, degraded, summary: llm.summary, findings: got, kind: call.kind };
        } catch (err) {
          const msg = (err as Error).message;
          console.warn(`[worker] ${call.label} failed:`, msg);
          return {
            ok: false,
            transient: isTransientLlmError(msg),
            degraded: false,
            summary: undefined as string | undefined,
            findings: [] as ReviewFinding[],
            kind: call.kind,
          };
        }
      });
    } finally {
      clearInterval(abortPoll);
    }

    if (prClosedMidRun) {
      console.log(`[worker] PR #${number} closed during review — discarding partial results, not posting`);
      return {
        findingCount: 0, newCount: 0, fixedCount: 0, skipReason: 'pr_closed_mid_run',
        ...totalUsage(usage),
      };
    }

    // If NOTHING succeeded — whether rate-limit/transport (e.g. a MiniMax
    // token-plan 429) OR every pass degraded to an unparseable response — FAIL
    // the review so it retries, rather than posting an empty "0 findings" that
    // reads as a clean pass. A genuinely clean review has ok:true calls, so it's
    // correctly distinguished.
    const okCount = outcomes.filter((o) => o.ok).length;
    const transientCount = outcomes.filter((o) => o.transient).length;
    const degradedCount = outcomes.filter((o) => o.degraded).length;
    if (okCount === 0 && transientCount + degradedCount > 0) {
      const why = transientCount > 0 ? 'rate-limit/transport errors (likely token-plan quota)' : 'unparseable model responses';
      throw new Error(
        `review aborted: all ${outcomes.length} model calls failed — ${why}. Will retry on the next push or \`@orvex review\`.`,
      );
    }

    // Summary comes from the first successful pass; findings accumulate.
    llmSummary = outcomes.find((o) => o.kind === 'pass' && o.ok)?.summary ?? llmSummary;
    for (const o of outcomes) accumulated.push(...o.findings);

    // dedupe the same bug surfaced by multiple passes/batches
    const seenFp = new Set<string>();
    llmFindings = accumulated.filter((f) => {
      const fp = fingerprintFinding(f);
      if (seenFp.has(fp)) return false;
      seenFp.add(fp);
      return true;
    });
    // Don't let a failed first pass ("Review could not be completed…") headline
    // the review when later passes/sweep batches actually found bugs.
    if (llmFindings.length > 0 && llmSummary?.startsWith('Review could not be completed')) {
      llmSummary = undefined;
    }
    console.log(`[worker] deep review done: ${toRun.length} model calls, ${llmFindings.length} unique findings`);
  }

  const incoming = dedupeByFileLine([...ruleFindings, ...llmFindings]);
  const merged = mergeFindings(incoming, verifiedOpen, effectiveSha, {
    minConfidence: reviewConfig.min_confidence,
    // Only files actually looked at this run can retire a prior finding. On an
    // incremental push `files` is just the newly-pushed diff, so a prior finding
    // in an un-touched file is carried forward, not falsely marked "fixed".
    reviewedFiles: new Set(files.map((f) => f.filename)),
  });

  // drop findings the team suppressed with `@orvex ignore`
  const suppressed = config.store.getSuppressedFingerprints(installationId, owner, repo);
  if (suppressed.size > 0) {
    merged.toPost = merged.toPost.filter((f) => !suppressed.has(fingerprintFinding(f)));
  }

  // drop self-negating findings ("impact is nil", "harmless", "nitpick") — the
  // model padding its count with things it admits don't matter.
  const denoised = dropSelfNegatingFindings(merged.toPost);
  if (denoised.dropped.length > 0) {
    console.log(
      `[worker] noise filter dropped ${denoised.dropped.length}: ` +
        denoised.dropped.map((f) => `${f.severity} ${f.file}`).join(', '),
    );
  }
  merged.toPost = denoised.kept;

  // adversarial verification pass: a skeptical second model call tries to
  // refute each finding against the source. Give it the changed code for EVERY
  // finding — full file content where deep-context fetched it, else the file's
  // diff — so it never rejects a real finding just because it "can't see the
  // source" (that was silently blanking valid reviews on large PRs).
  const verifyFiles = [...reviewContextFiles];
  const haveContent = new Set(reviewContextFiles.map((f) => f.path));
  for (const file of filesForLlm) {
    if (!haveContent.has(file.filename) && file.patch) {
      verifyFiles.push({ path: file.filename, content: `Diff (changed lines) for this file:\n${file.patch}` });
      haveContent.add(file.filename);
    }
  }
  if (merged.toPost.length > 0 && process.env.ORVEX_VERIFY !== '0' && verifyFiles.length > 0) {
    const verified = await verifyFindings(merged.toPost, verifyFiles, {
      apiKey: llm.apiKey,
      model: llm.model,
      baseUrl: llm.baseUrl,
      prIntent,
    });
    if (verified.dropped.length > 0) {
      console.log(
        `[worker] verification dropped ${verified.dropped.length}/${merged.toPost.length}: ` +
          verified.dropped.map((d) => `${d.finding.file} (${d.reason.slice(0, 60)})`).join(' | '),
      );
    }
    merged.toPost = verified.kept;
  }

  // snap finding lines to lines actually added in the diff — GitHub rejects
  // inline comments on unchanged lines; far-off guesses become summary-only
  const addedLinesByFile = buildAddedLineIndex(files);
  merged.toPost = merged.toPost.map((f) => normalizeFindingLine(f, addedLinesByFile));

  const allFixed = dedupeByFingerprint([...verifiedFixed, ...merged.newlyFixed]);
  let { inline, summaryOnly } = filterAndCapFindings(merged.toPost, reviewConfig);

  // cumulative cap: repeated re-reviews must never bury a PR in comments.
  // Once ORVEX_MAX_INLINE_PER_PR (default 100) inline comments exist across the
  // PR's lifetime, further findings go to the summary table only. High default:
  // every finding should carry its apply-fix checkbox; this is a runaway guard.
  const maxInlinePerPr = Number(process.env.ORVEX_MAX_INLINE_PER_PR ?? 100);
  const priorInline = (priorState?.findings ?? []).filter((f) => f.githubCommentId).length;
  const inlineBudget = Math.max(0, maxInlinePerPr - priorInline);
  if (inline.length > inlineBudget) {
    summaryOnly = [...summaryOnly, ...inline.slice(inlineBudget)];
    inline = inline.slice(0, inlineBudget);
    console.log(
      `[worker] inline budget: ${priorInline} existing, capping new inline to ${inlineBudget}`,
    );
  }

  const stats = {
    newCount: merged.toPost.length,
    fixedCount: allFixed.length,
    openCount: merged.stillOpen.length + merged.toPost.length,
  };

  let reviewId: number | undefined;
  const commentIdMap = new Map<string, number>();

  // ALWAYS post a review — even with zero findings — so a completed review is
  // never silent. A clean review still reports the files it read, an assessment,
  // and what it checked for.
  {
    const summary =
      llmSummary ??
      (stats.fixedCount > 0
        ? `All previously reported issues appear fixed on \`${effectiveSha.slice(0, 7)}\`.`
        : undefined);

    const body = formatReviewBody(inline, summaryOnly, {
      owner,
      repo,
      pr: number,
      headSha: effectiveSha,
      stats,
      summary,
      filesReviewed: filesForLlm.map((f) => f.filename),
    });

    const inlineComments: InlineReviewComment[] = inline
      .filter((f) => f.line)
      .map((f) => ({
        path: f.file,
        line: f.line!,
        body: formatInlineBody(f, plan.autofix),
      }));

    // Advisory by default: post as COMMENT (never blocks the PR). Set
    // ORVEX_REQUEST_CHANGES=1 to use REQUEST_CHANGES on P1 findings.
    const hasP1 = merged.toPost.some((f) => f.severity === 'P1');
    const event =
      hasP1 && process.env.ORVEX_REQUEST_CHANGES === '1' ? 'REQUEST_CHANGES' : 'COMMENT';
    const review = await postPullRequestReview(octokit, ref, effectiveSha, body, inlineComments, event);
    reviewId = review.reviewId;

    for (const c of review.commentIds) {
      commentIdMap.set(`${c.path}:${c.line}`, c.id);
    }
  }

  const newStored: StoredFinding[] = merged.toPost.map((f) => {
    const stored = toStoredFinding(f, effectiveSha);
    const key = f.line ? `${f.file}:${f.line}` : null;
    if (key && commentIdMap.has(key)) {
      stored.githubCommentId = commentIdMap.get(key);
    }
    return stored;
  });

  const fixedFps = new Set(allFixed.map((f) => f.fingerprint));

  const updatedPrior = (priorState?.findings ?? []).map((f) => {
    const fixed = allFixed.find((x) => x.fingerprint === f.fingerprint);
    if (fixed) return fixed;
    const still = merged.stillOpen.find((x) => x.fingerprint === f.fingerprint);
    if (still) return still;
    if (fixedFps.has(f.fingerprint)) {
      return { ...f, status: 'fixed' as const, fixedAtSha: effectiveSha };
    }
    return f;
  });

  const knownFps = new Set(updatedPrior.map((f) => f.fingerprint));
  const finalFindings = [
    ...updatedPrior,
    ...newStored.filter((s) => !knownFps.has(s.fingerprint)),
  ];

  const state: PrReviewState = {
    installationId,
    tenantId,
    owner,
    repo,
    pr: number,
    lastSha: effectiveSha,
    findings: finalFindings,
    lastReviewAt: new Date().toISOString(),
  };
  config.store.saveState(state);

  // update the dashboard PR row with the latest open-finding count
  const openCount = finalFindings.filter((f) => f.status === 'open').length;
  config.store.markReviewedNow(installationId, `${owner}/${repo}`, number, openCount);

  if (config.enableCheckRuns) {
    const openP1 = finalFindings.some((f) => f.status === 'open' && f.severity === 'P1');
    const openAny = finalFindings.some((f) => f.status === 'open');
    // Advisory: never fail the check (no red ✗). Findings show as 'neutral';
    // set ORVEX_FAIL_CHECK_ON_P1=1 to hard-fail on open P1s if you want gating.
    const conclusion =
      openP1 && process.env.ORVEX_FAIL_CHECK_ON_P1 === '1'
        ? 'failure'
        : openAny
          ? 'neutral'
          : 'success';
    await createCheckRun(octokit, ref, effectiveSha, {
      conclusion,
      title: 'Orvex Review',
      summary: `${stats.newCount} new, ${stats.fixedCount} fixed, ${stats.openCount} open`,
    });
  }

  // ——— Tier-2 (Verify plan): runtime verification in a sandbox ———
  // Gated by BOTH the tenant's plan (codeExecution) and ORVEX_CODE_EXECUTION=1,
  // so it never runs for lower tiers and stays off until execution is enabled.
  if (plan.codeExecution && process.env.ORVEX_CODE_EXECUTION === '1') {
    try {
      console.log(`[worker] tier-2 runtime verify (plan=${plan.id}) PR #${number}…`);
      const rv = await runtimeVerify(octokit, owner, repo, effectiveSha);
      const evidence = formatRuntimeEvidence(rv);
      if (evidence) {
        await octokit.rest.issues.createComment({ owner, repo, issue_number: number, body: evidence });
        console.log(`[worker] tier-2 runtime verify posted: ran=${rv.ran} steps=${rv.steps.length}`);
      } else {
        console.log(`[worker] tier-2 runtime verify skipped: ${rv.skippedReason}`);
      }
    } catch (err) {
      console.warn('[worker] tier-2 runtime verify failed (non-fatal):', (err as Error).message);
    }
  }

  console.log(
    `[worker] done PR #${number}: ${stats.newCount} new, ${stats.fixedCount} fixed, ${stats.openCount} open`,
  );

  const { inputTokens, outputTokens, costUsd } = totalUsage(usage);
  if (inputTokens + outputTokens > 0) {
    const mix = plan.modelTier === 'hybrid' ? ' (hybrid: MiniMax+GLM)' : '';
    console.log(`[worker] PR #${number} usage${mix}: ${inputTokens} in + ${outputTokens} out ≈ $${costUsd.toFixed(4)}`);
  }

  return {
    findingCount: stats.openCount,
    newCount: stats.newCount,
    fixedCount: stats.fixedCount,
    reviewId,
    inputTokens,
    outputTokens,
    costUsd,
  };
}

async function runDeterministicRules(
  octokit: ReturnType<typeof createInstallationOctokit>,
  owner: string,
  repo: string,
  headSha: string,
  files: Array<{ filename: string; status: string }>,
  config: ReviewConfig,
): Promise<ReviewFinding[]> {
  const findings: ReviewFinding[] = [];

  for (const file of files) {
    if (shouldIgnorePath(file.filename, config)) continue;

    if (file.filename.endsWith('.md')) {
      const content = await fetchFileContent(octokit, owner, repo, file.filename, headSha);
      if (content) {
        findings.push(
          ...auditFindingsFromContent(content, file.filename).map((f) => ({
            ...f,
            severity: f.severity as ReviewFinding['severity'],
          })),
        );
      }
    }
  }

  if (config.run_semgrep) {
    const paths = files
      .map((f) => f.filename)
      .filter((p) => !shouldIgnorePath(p, config) && /\.(js|ts|jsx|tsx|py|go)$/.test(p));
    const semgrep = await runSemgrepOnPaths(paths);
    findings.push(
      ...semgrep.map((f) => ({
        ...f,
        severity: f.severity as ReviewFinding['severity'],
      })),
    );
  }

  return findings;
}

function formatInlineBody(f: ReviewFinding, canAutofix: boolean): string {
  return formatInlineFinding({
    finding: {
      severity: f.severity,
      ruleId: f.ruleId,
      message: f.message,
      suggestion: f.suggestion,
      originalCode: f.originalCode,
      fixedCode: f.fixedCode,
      fingerprint: fingerprintFinding(f),
    },
    trigger: commandTrigger(),
    canAutofix,
  });
}

function dedupeByFingerprint(findings: StoredFinding[]): StoredFinding[] {
  const byFp = new Map<string, StoredFinding>();
  for (const f of findings) {
    byFp.set(f.fingerprint, f);
  }
  return [...byFp.values()];
}

type AddedLineMap = Map<string, Set<number>>;

function buildAddedLineIndex(files: Array<{ filename: string; patch?: string }>): AddedLineMap {
  const map: AddedLineMap = new Map();
  for (const file of files) {
    if (!file.patch) continue;
    const lines = parseAddedLinesFromPatch(file.patch);
    if (lines.size > 0) {
      map.set(file.filename, lines);
    }
  }
  return map;
}

function parseAddedLinesFromPatch(patch: string): Set<number> {
  // Every RIGHT-side line present in the new file — ADDED lines AND the CONTEXT
  // lines around them — is a valid inline-comment anchor on GitHub. Capturing
  // context too is what makes findings on DELETION-ONLY hunks (+0/-N files)
  // anchorable: the removed code is gone, but the surrounding lines remain, so a
  // finding about the removal still gets an inline comment + apply-fix checkbox
  // instead of falling silently into the summary table.
  const commentable = new Set<number>();
  let newLine = 0;

  for (const rawLine of patch.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const match = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(line);
    if (match) {
      newLine = Number(match[1]);
      continue;
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      if (newLine > 0) commentable.add(newLine);
      newLine += 1;
      continue;
    }
    if (line.startsWith('-')) {
      continue; // deleted line — no new-side number to anchor to
    }
    // context line: present in the new file, so a valid anchor.
    if (newLine > 0) {
      commentable.add(newLine);
      newLine += 1;
    }
  }

  return commentable;
}

function normalizeFindingLine(finding: ReviewFinding, addedLinesByFile: AddedLineMap): ReviewFinding {
  const candidateLines = addedLinesByFile.get(finding.file);
  // file not part of the diff's added lines (pure deletion / unchanged) → summary-only
  if (!candidateLines || candidateLines.size === 0) {
    return { ...finding, line: undefined };
  }
  // exact hit
  if (finding.line && candidateLines.has(finding.line)) {
    return finding;
  }
  // Anchor to the nearest changed line in the same file so the finding still
  // gets an inline comment (and its fix checkbox). GitHub only accepts inline
  // comments on changed lines; a slightly-off anchor is far better than hiding
  // the finding — and its fix button — in a summary table. Only a finding whose
  // file has no changed lines at all stays summary-only (handled above).
  const anchor = nearestAddedLine(candidateLines, finding.line);
  return { ...finding, line: anchor };
}

/** Nearest changed line to `requested`, or the first changed line if no hint. */
function nearestAddedLine(addedLines: Set<number>, requested?: number): number {
  let bestLine = Number.POSITIVE_INFINITY;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const addedLine of addedLines) {
    if (requested === undefined) {
      if (addedLine < bestLine) bestLine = addedLine;
      continue;
    }
    const distance = Math.abs(addedLine - requested);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestLine = addedLine;
      if (distance === 0) break;
    }
  }
  return Number.isFinite(bestLine) ? bestLine : (requested ?? 1);
}
