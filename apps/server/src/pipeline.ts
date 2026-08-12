import { createInstallationOctokit } from '@orvex-review/github';
import type { ReviewJobPayload } from '@orvex-review/queue';
import { commandTrigger, isTransientLlmError } from '@orvex-review/review';
import { planFeatures } from '@orvex-review/tenants';
import { formatLimitBlockedComment, loadAccountQuotaStatus } from './quota-status.js';
import {
  canRunAgentic,
  hasPinnedCodexLuna,
  DEFAULT_REVIEW_ROUTING_POLICY,
  type ReviewRoutingPolicy,
} from './review/model-routing.js';
import type { WorkerConfig } from './review/worker-types.js';
import {
  accountLimitReason,
  prepaidOverageDebitCents,
  createAccountLimitPolicy,
} from './review/account-limits.js';
import { createUsageCostPolicy } from './review/usage-accounting.js';
import { compileReviewPlan } from '@orvex-review/review';
import { createProviderCatalog } from './review/provider-catalog.js';
export { loadWorkerConfig } from './bootstrap/review-config.js';
import {
  AdmissionService,
  FinalizationService,
  FindingPipeline,
  PublicationService,
  ReviewExecutor,
  ReviewPreparation,
  executeReviewCore,
  type ProcessResult,
  type ReviewPipelineServices,
} from './application/review/index.js';
export { effectiveReviewConfig } from './application/review/review-preparation.js';
export {
  canRunAgentic,
  canRunCodexCli,
  canRunInvestigate,
  canRunRiskHunt,
  contextForReviewPass,
  maxOutputTokensForModel,
  modelForInvestigate,
  modelForRiskHunt,
  validateNativeOpenAiResponsesConfig,
  createReviewRoutingPolicy,
} from './review/model-routing.js';
export type { ReviewRoutingPolicy } from './review/model-routing.js';
export type { LlmTarget, PassTier, WorkerConfig } from './review/worker-types.js';
export {
  accountUsage,
  actualPassTier,
  createUsageCostPolicy,
  createUsageRecorder,
  usageProvider,
} from './review/usage-accounting.js';
export type { AccountedUsage, UsageCostPolicy, UsageEvent } from './review/usage-accounting.js';
export {
  accountLimitReason,
  createAccountLimitPolicy,
  prepaidOverageDebitCents,
} from './review/account-limits.js';
export type { AccountLimitPolicy } from './review/account-limits.js';

/**
 * Download + extract the repo at `ref` into a temp dir for agentic exploration
 * (Codex CLI or the sandboxed investigate tier). Fail-safe: returns null on any
 * error. Agentic reviews fail closed if this checkout is unavailable; optional
 * investigate-only callers may still continue without the extra tool pass.
 */
export {
  failedRequiredCoverageKeys,
  failedRequiredLensIds,
  takeReviewCallsByPriority,
} from './application/review/review-executor.js';
export { runPostPublicationStep } from './application/review/finalization-service.js';
export { mayPublishRuntimeEvidence } from './application/review/publication-service.js';

/** The model + cost-tier for a given review PASS.
 *  - 'codex-hybrid' → pass 1 (general) on CODEX (sharp), pass 2+ (deep-dive) on
 *    MiniMax (thorough breadth, and it reasons hard where codex's deep-dive skips).
 *  - 'multi-model'  → THREE discovery passes for blind-spot diversity:
 *    pass 1 Luna/Codex (general), pass 2 DeepSeek v4 Flash (deep-dive plus
 *    removed-behavior/callers), pass 3 MiniMax
 *    (perf/completeness), followed by a separate Flash verification pass.
 *  - 'dual-model' → TWO discovery passes: MiniMax (general) + DeepSeek v4 Flash
 *    (deep-dive). Flash also runs the end-of-review verify pass.
 * Legacy model-tier values remain readable for stored configuration, but the
 * public plans route only through the dual-model and multi-model tracks above. */
/**
 * Can this review run the AGENTIC path (codex CLI with a repo checkout) instead
 * of a one-shot API call? This is the ONLY place the question is answered.
 *
 * All three conditions are load-bearing:
 *  1. the feature flag is on;
 *  2. the plan designates an OpenAI-model pass 1 (other tiers were never
 *     designed for it, and shouldn't get CLI-routed by accident);
 *  3. the repository is enabled in the customer's Orvex account (GitHub-synced
 *     dashboard enablement). Auto-review-on-open/push toggles do not apply.
 */
/**
 * Re-export pass-budget helpers so existing `from './pipeline.js'` test imports keep working.
 */
export {
  maxRiskProbes,
  selectRiskProbes,
  isLargePr,
  hasDeleteOrRename,
  buildReviewPassAngles,
} from '@orvex-review/review';
export type { PassAngle } from '@orvex-review/review';

/** Compatibility helper for direct unit tests. Production gets this policy
 * from the immutable bootstrap snapshot on WorkerConfig. */
export function loadReviewRoutingPolicy(): ReviewRoutingPolicy {
  return DEFAULT_REVIEW_ROUTING_POLICY;
}

function runtimeFor(config: WorkerConfig): NonNullable<WorkerConfig['reviewRuntime']> {
  return (
    config.reviewRuntime ??
    Object.freeze({
      routingPolicy: DEFAULT_REVIEW_ROUTING_POLICY,
      accountLimits: Object.freeze({
        freeTierDailyCap: 300,
        cogsReservationUsd: 5,
        monthlyCogsCapUsd: 250,
      }),
      usageCosts: Object.freeze({
        premium: Object.freeze({ input: 1.4, cachedInput: 1.4, output: 4.4 }),
        standard: Object.freeze({ input: 0.3, cachedInput: 0.06, output: 1.2 }),
        openai: Object.freeze({ input: 0.2, cachedInput: 0.02, output: 1.2 }),
        deepseek: Object.freeze({ input: 0.435, cachedInput: 0.003625, output: 0.87 }),
        'deepseek-flash': Object.freeze({ input: 0.14, cachedInput: 0.0028, output: 0.28 }),
        modelRates: Object.freeze({
          'gpt-5.6-luna': Object.freeze({ input: 1, cachedInput: 0.1, output: 6 }),
          'deepseek-v4-pro': Object.freeze({ input: 0.435, cachedInput: 0.003625, output: 0.87 }),
          'deepseek-v4-flash': Object.freeze({ input: 0.14, cachedInput: 0.0028, output: 0.28 }),
          'minimax-m3': Object.freeze({ input: 0.3, cachedInput: 0.06, output: 1.2 }),
        }),
      }),
      preparation: Object.freeze({
        deepContextEnabled: true,
        contextSourceFiles: 40,
        contextRelatedFiles: 12,
        contextDependents: 8,
        contextFileBytes: 120_000,
        riskContextBoost: false,
        archiveMaxBytes: 150_000_000,
      }),
      publication: Object.freeze({
        requestChangesOnP1: false,
        maxUnanchoredComments: 3,
        failCheckOnP1: false,
      }),
      execution: Object.freeze({
        abortPollMs: 5_000,
        maxCalls: 28,
        concurrency: 3,
        maxOtherChars: 45_000,
        sweepFileChars: 10_000,
        maxInlinePerPr: 100,
        aggregation: Object.freeze({
          runs: 1,
          minOccurrences: 1,
          temperature: 0.2,
          maxCandidates: 120,
          enabled: false,
        }),
      }),
      verifyConcurrency: 1,
      cooldownSeconds: 120,
      verificationEnabled: true,
    })
  );
}

export type { ProcessResult } from './application/review/index.js';

export function providerConfigurationIssue(
  plan: ReturnType<typeof planFeatures>,
  config: WorkerConfig,
  repoId?: string,
  routingPolicy: ReviewRoutingPolicy = runtimeFor(config).routingPolicy,
  installationId?: number,
): string | null {
  const publicPlan = compileReviewPlan(plan.modelTier);
  if (publicPlan) {
    // ProviderCatalog is the one contract compiler for public plans. Keep the
    // external messages stable while refusing every substitution before spend.
    try {
      createProviderCatalog(config).compilePublicPlan(plan.modelTier, {
        agenticLuna: Boolean(repoId && canRunAgentic(plan, repoId, routingPolicy, installationId)),
      });
    } catch (err) {
      const message = (err as Error).message;
      if (message.includes('MiniMax')) {
        return 'The MiniMax review provider is not configured for this plan. This review was not run; contact support to restore provider capacity.';
      }
      if (message.includes('DeepSeek v4 Flash')) {
        return 'The DeepSeek v4 Flash review provider is not configured. This review was not run; contact support to restore provider capacity.';
      }
      if (message.includes('Luna') || message.includes('Codex CLI')) {
        return 'The Luna review provider is not configured for this plan. This review was not run; contact support to restore provider capacity.';
      }
      throw err;
    }
    return null;
  }
  // Non-public historical tiers retain their narrow legacy behavior only while
  // old persisted workspace settings are migrated. They never route a public plan.
  if (
    plan.modelTier === 'codex-hybrid' &&
    !hasPinnedCodexLuna(config, plan, repoId, routingPolicy, installationId)
  ) {
    return 'The Luna review provider is not configured for this plan. This review was not run; contact support to restore provider capacity.';
  }
  return null;
}

const LIMIT_NUDGE_COOLDOWN_MS = 30 * 60_000;

/** Post a clear quota nudge when a review is blocked (best-effort, deduped per PR). */
async function postLimitNudge(
  config: WorkerConfig,
  job: ReviewJobPayload,
  plan: ReturnType<typeof planFeatures>,
  reason:
    | 'rate_limited'
    | 'monthly_limit'
    | 'trial_exhausted'
    | 'cost_capped'
    | 'concurrency_limited'
    | 'insufficient_credits',
): Promise<void> {
  // Skip if we already recorded (and nudged for) this reason on this PR recently.
  // Count includes the skip row just written by the caller — >1 means a prior skip.
  const recent = config.store.countRecentSkippedRuns(
    {
      installationId: job.installationId,
      owner: job.owner,
      repo: job.repo,
      pr: job.pr,
    },
    reason,
    LIMIT_NUDGE_COOLDOWN_MS,
  );
  if (recent > 1) {
    console.log(`[worker] ${reason} ${job.owner} (plan=${plan.id}) — nudge suppressed (cooldown)`);
    return;
  }
  const status = loadAccountQuotaStatus(config.store, job.owner, job.tenantId, plan);
  const body = formatLimitBlockedComment(status, reason, commandTrigger());
  try {
    const octokit = createInstallationOctokit(config.github, job.installationId);
    await octokit.rest.issues.createComment({
      owner: job.owner,
      repo: job.repo,
      issue_number: job.pr,
      body,
    });
    console.log(`[worker] ${reason} ${job.owner} (plan=${plan.id})`);
  } catch {
    /* nudge is best-effort */
  }
}

/** Tell the PR owner when no trustworthy verdict was produced. */
async function postReviewFailureNotice(
  config: WorkerConfig,
  job: ReviewJobPayload,
  error: string,
): Promise<void> {
  const transient = isTransientLlmError(error);
  const incompleteInput = /review input coverage incomplete; no model calls were made/i.test(error);
  const marker = `<!-- orvex-review-failure:${job.installationId}:${job.owner}/${job.repo}#${job.pr}@${job.headSha} -->`;
  const body = [
    marker,
    '⚠️ **Orvex could not complete this review.**',
    '',
    transient
      ? 'A review provider was temporarily unavailable or rate-limited. Orvex will retry automatically when possible.'
      : incompleteInput
        ? 'GitHub did not provide a complete diff, so Orvex stopped before calling or charging any review model. Split the pull request or reduce the changed-file/diff size, then request a new review.'
        : 'No clean-review verdict was produced because the review pipeline failed before it could complete.',
    '',
    incompleteInput
      ? 'This protection prevents a partial review from being mistaken for a complete sign-off.'
      : 'Please push a new commit or comment `@orvex review` to try again. If this keeps happening, contact support@useorvex.com.',
  ].join('\n');
  try {
    const octokit = createInstallationOctokit(config.github, job.installationId);
    await octokit.rest.issues.createComment({
      owner: job.owner,
      repo: job.repo,
      issue_number: job.pr,
      body,
    });
  } catch (noticeError) {
    console.warn(
      '[worker] review failure notice could not be posted:',
      (noticeError as Error).message,
    );
  }
}

async function postCooldownNotice(
  config: WorkerConfig,
  job: ReviewJobPayload,
  sinceSeconds: number,
  waitSeconds: number,
): Promise<void> {
  try {
    const octokit = createInstallationOctokit(config.github, job.installationId);
    await octokit.rest.issues.createComment({
      owner: job.owner,
      repo: job.repo,
      issue_number: job.pr,
      body: `⏳ This commit was already reviewed ${sinceSeconds}s ago — re-running now would just repeat it. Try again in ~${waitSeconds}s, or push a new commit for a fresh review.`,
    });
  } catch {
    /* best-effort */
  }
}

/** Coordinates the six review services. Provider execution and GitHub
 * publication remain behind injected boundaries so they can be tested alone. */
export function createReviewPipelineServices(config: WorkerConfig): ReviewPipelineServices {
  const runtime = runtimeFor(config);
  const routingPolicy = runtime.routingPolicy;
  const accountPolicy = createAccountLimitPolicy(runtime.accountLimits);
  const usagePolicy = createUsageCostPolicy(runtime.usageCosts);
  const admission = new AdmissionService({
    providerIssue: (plan, worker, repoId, installationId) =>
      providerConfigurationIssue(plan, worker, repoId, routingPolicy, installationId),
    accountLimitReason: (store, owner, plan, pending, excluded, options) =>
      accountLimitReason(store, owner, plan, pending, excluded, options, accountPolicy),
    prepaidOverageDebitCents,
    postLimitNudge,
    postFailureNotice: postReviewFailureNotice,
    postCooldownNotice,
    cooldownSeconds: () => runtime.cooldownSeconds,
  });
  const preparation = new ReviewPreparation({
    persistJob: config.persistJob,
    policy: runtime.preparation,
  });
  const findingPipeline = new FindingPipeline();
  const publication = new PublicationService(config.store);
  const finalization = new FinalizationService({ postFailureNotice: postReviewFailureNotice });
  const publicationPolicy = runtime.publication;
  const executionPolicy = runtime.execution;
  let executor: ReviewExecutor;
  executor = new ReviewExecutor((request) =>
    executeReviewCore(request, {
      findingPipeline,
      publication,
      preparation,
      finalization,
      executor,
      routingPolicy,
      usagePolicy,
      verificationEnabled: runtime.verificationEnabled,
      publicationPolicy,
      executionPolicy,
      verificationConcurrency: runtime.verifyConcurrency,
    }),
  );
  return { admission, preparation, executor, finalization };
}

export async function processReviewJob(
  job: ReviewJobPayload,
  config: WorkerConfig,
  services: ReviewPipelineServices = createReviewPipelineServices(config),
): Promise<ProcessResult> {
  const admitted = await services.admission.admit(job, config);
  if (admitted.kind === 'skipped') return admitted.result;

  let review = admitted.review;

  try {
    const prepared = await services.preparation.prepare(job, config, admitted.review.runId);
    review = { ...admitted.review, ...prepared };
    return await services.finalization.complete(review, await services.executor.execute(prepared));
  } catch (error) {
    return services.finalization.fail(review, error);
  }
}
