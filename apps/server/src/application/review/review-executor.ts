import { fetchFileContent, isPrStillOpen, isRepoAllowed } from '@orvex-review/github';
import {
  assertCodexRuntimeReady,
  fingerprintFinding,
  mergeFindingProvenance,
  waitForProviderAvailability,
  summarizeModelContribution,
  tagFindingProvenance,
  formatModelContribution,
  type ReviewFinding,
  type ReviewPromptContext,
  type ReviewSurfaceFinding,
  compileReviewPlan,
} from '@orvex-review/review';
import { planFeatures } from '@orvex-review/tenants';
import { activeReviewSignal } from '../../active-reviews.js';
import {
  canRunAgentic,
  canRunCodexCli,
  canRunInvestigate,
  modelForInvestigate,
  modelForPass,
  modelForPlanWithTier,
  type ReviewRoutingPolicy,
} from '../../review/model-routing.js';
import type { LlmTarget, PassTier } from '../../review/worker-types.js';
import { totalUsage, type UsageCostPolicy } from '../../review/usage-accounting.js';
import { createProviderCatalog } from '../../review/provider-catalog.js';
import { createProviderAdapterRegistry } from '../../review/provider-registry.js';
import type { ReviewPreparation } from './review-preparation.js';
import type { FinalizationService } from './finalization-service.js';
import { FindingPipeline } from './finding-pipeline.js';
import { PublicationService, type PublicationPolicy } from './publication-service.js';
import { createReviewUsageAccounting } from './review-usage-accounting.js';
import { scheduleReviewStages, selectScheduledReviewCalls } from './review-stage-scheduler.js';
import type { ReviewExecutionPolicy } from './review-execution-policy.js';
import { resolvePrStatePollMs } from './review-execution-policy.js';
import { executeReviewProviderCalls, type ReviewCallOutcome } from './review-provider-execution.js';
import { orchestrateVerification } from './verification-orchestrator.js';
import type { PreparedExecutionReview, ProcessResult } from './types.js';

export interface RequiredLensOutcome {
  modelPassIndex?: number;
  ok: boolean;
  bestEffort?: boolean;
}

export function failedRequiredLensIds(
  lensIds: readonly number[],
  outcomes: readonly RequiredLensOutcome[],
  requiredSuccesses: number,
): number[] {
  return lensIds.filter(
    (lensId) =>
      outcomes.filter(
        (outcome) => outcome.modelPassIndex === lensId && outcome.ok && !outcome.bestEffort,
      ).length < requiredSuccesses,
  );
}

export { takeReviewCallsByPriority } from './review-execution-policy.js';
export type { ReviewExecutionPolicy } from './review-execution-policy.js';

export interface ReviewExecutionServices {
  findingPipeline: FindingPipeline;
  publication: PublicationService;
  preparation: Pick<ReviewPreparation, 'checkoutRepoForAgent'>;
  finalization: Pick<FinalizationService, 'cleanupCheckout' | 'cleanupCancellation'>;
  executor: ReviewExecutor;
  routingPolicy: ReviewRoutingPolicy;
  usagePolicy: UsageCostPolicy;
  verificationEnabled: boolean;
  publicationPolicy: PublicationPolicy;
  executionPolicy: ReviewExecutionPolicy;
}

export type ReviewComputation = (review: PreparedExecutionReview) => Promise<ProcessResult>;

export class ReviewExecutor {
  constructor(private readonly compute: ReviewComputation) {}

  execute(review: PreparedExecutionReview): Promise<ProcessResult> {
    return this.compute(review);
  }

  async mapConcurrent<T, R>(
    items: readonly T[],
    limit: number,
    run: (item: T, index: number) => Promise<R>,
  ): Promise<R[]> {
    const results = new Array<R>(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= items.length) return;
        results[index] = await run(items[index]!, index);
      }
    });
    await Promise.all(workers);
    return results;
  }
}

export async function executeReviewCore(
  prepared: PreparedExecutionReview,
  services: ReviewExecutionServices,
): Promise<ProcessResult> {
  const {
    job,
    config,
    runId,
    ref,
    octokit,
    pr,
    effectiveSha,
    reviewConfig,
    priorState,
    files,
    coverage,
    verifiedOpen,
    verifiedFixed,
    readErrorFps,
    ruleFindings,
    filesForLlm,
    filesForInvestigate,
    highRiskDiff,
    reviewContext,
    reviewContextFiles,
    repoTreePaths,
  } = prepared;
  if (prepared.skipResult) return prepared.skipResult;
  const { routingPolicy, usagePolicy, verificationEnabled, publicationPolicy, executionPolicy } =
    services;
  const { installationId, tenantId, owner, repo, pr: number } = job;

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
  const compiledPlan = compileReviewPlan(plan.modelTier);
  const providerCatalog = createProviderCatalog(config);
  const codexContainer = config.providerDependencies?.codexContainer;
  // New worker construction injects distributed admission/dependencies here.
  // This default is the only compatibility bridge for older bootstrap callers
  // that still configure the historical process-global coordinator.
  const providerRegistry =
    config.providerRegistry ??
    createProviderAdapterRegistry({
      dependencies: {
        ...config.providerDependencies,
        admission: config.providerAdmission,
        codexContainer,
      },
    });
  const resolvedPublicPlan = providerCatalog.compilePublicPlan(plan.modelTier, {
    agenticLuna: canRunAgentic(plan, `${owner}/${repo}`, routingPolicy),
  });
  // The review passes use modelForPass (may be codex on the Verify test); the
  // single verification pass uses a plan-aware target; retain its cost tier so
  // usage accounting follows the model that actually received the request.
  const verificationTarget = resolvedPublicPlan
    ? resolvedPublicPlan.verification
    : modelForPlanWithTier(config, plan);
  const llm = verificationTarget.target;
  const verificationTier = verificationTarget.tier;
  const reviewModel = resolvedPublicPlan
    ? resolvedPublicPlan.discovery[0]!.target.model
    : modelForPass(config, plan, 0, canRunCodexCli(plan, routingPolicy), routingPolicy).target
        .model;
  console.log(`[worker] plan=${plan.id} review=${reviewModel} verify=${llm.model}`);

  console.log(
    `[worker] tenant=${tenantId.slice(0, 8)} inst=${installationId} account=${installation.accountLogin} plan=${plan.id}`,
  );

  // One cancellation signal follows every paid transport used by this review.
  // The close/merge webhook aborts the active-review signal immediately in the
  // current process. A slower authoritative GitHub poll provides the durable
  // fallback across restarts or future multi-process workers without spending
  // the installation's API quota on one request per review every five seconds.
  let prClosedMidRun = false;
  let runOwnershipLost = false;
  const reviewAbortController = new AbortController();
  const cancelClosedReview = () => {
    if (!prClosedMidRun) {
      prClosedMidRun = true;
      console.warn(`[worker] PR #${number} closed mid-review — aborting active paid calls`);
    }
    if (!reviewAbortController.signal.aborted) {
      reviewAbortController.abort('pr_closed_mid_run');
    }
  };
  const cancelForOwnershipLoss = () => {
    if (!runOwnershipLost) {
      runOwnershipLost = true;
      console.warn(
        `[worker] review run ownership lost for PR #${number} — aborting active paid calls`,
      );
    }
    if (!reviewAbortController.signal.aborted) {
      reviewAbortController.abort('review_run_ownership_lost');
    }
  };
  const parentSignal = activeReviewSignal();
  parentSignal?.addEventListener('abort', cancelClosedReview, { once: true });
  if (parentSignal?.aborted) cancelClosedReview();

  const abortPollMs = executionPolicy.abortPollMs;
  const ownershipHeartbeat = setInterval(() => {
    if (runId && !config.store.heartbeatReviewRun(runId)) cancelForOwnershipLoss();
  }, abortPollMs);
  ownershipHeartbeat.unref?.();
  const prStatePollMs = resolvePrStatePollMs(abortPollMs);
  let prStatePoll: ReturnType<typeof setTimeout> | undefined;
  let prStatePollingStopped = false;
  const pollPrState = async () => {
    try {
      const open = await isPrStillOpen(octokit, ref, AbortSignal.timeout(25_000));
      if (!open) cancelClosedReview();
    } catch {
      // The webhook remains authoritative; a bounded fallback poll retries later.
    } finally {
      if (!prStatePollingStopped) {
        prStatePoll = setTimeout(pollPrState, prStatePollMs);
        prStatePoll.unref?.();
      }
    }
  };
  prStatePoll = setTimeout(pollPrState, prStatePollMs);
  prStatePoll.unref?.();

  try {
    if (!runId) throw new Error('durable fixed-finding publication requires a review run');
    await services.publication.publishFixedReplies({
      scope: { tenantId, runId },
      octokit,
      owner,
      repo,
      number,
      effectiveSha,
      fixed: verifiedFixed,
    });

    // Codex CLI session id for this PR — re-used across re-reviews so the model
    // keeps the same conversation context; undefined starts a fresh session.
    let codexThreadId = priorState?.codexThreadId;

    let llmSummary: string | undefined;
    // Best-effort passes that failed — surfaced in the posted review so a partial
    // run can never read as a full sign-off.
    let skippedLenses: string[] = [];
    // Only true once an extra deep lens has actually produced a review.
    let deepLensesRan = false;
    let llmFindings: ReviewFinding[] = [];
    let aggregationManualCandidates: ReviewSurfaceFinding[] = [];
    const accounting = createReviewUsageAccounting({
      store: config.store,
      runId,
      tenantId,
      policy: usagePolicy,
      onOwnershipLoss: cancelForOwnershipLoss,
    });
    const { usage, onUsageFor, onAttemptFor } = accounting;
    if (filesForLlm.length > 0) {
      // Depth is enforced HERE, in the harness, and scaled BY PLAN — not left to
      // how long one model call decides to think. Higher tiers get the fixed four
      // discovery lenses plus verification. Findings accumulate and dedupe by
      // fingerprint; a hard call-count cap prevents runaway.
      // Reviewers and verifier receive diff and code context only — PR title/body
      // are a prompt-injection channel and reach no model prompt anywhere.
      const baseCtx: ReviewPromptContext = { ...(reviewContext ?? {}) };
      const runReview = (
        ctx: typeof baseCtx,
        target: LlmTarget,
        tier: PassTier,
        passName: string,
        temperature?: number,
      ) =>
        providerRegistry.runReview(filesForLlm, target, {
          temperature,
          context: ctx,
          signal: reviewAbortController.signal,
          onUsage: onUsageFor(tier, target, passName),
          onAttempt: onAttemptFor(tier, passName),
        });
      const passes = compiledPlan?.discovery.length ?? Math.max(1, plan.reviewPasses);
      const maxCalls = Math.max(passes, executionPolicy.maxCalls);
      const concurrency = executionPolicy.concurrency;
      const accumulated: ReviewFinding[] = [];
      const tagFindings = (findings: ReviewFinding[], tier: PassTier, passTag?: string) => {
        for (const finding of findings) tagFindingProvenance(finding, tier, passTag);
      };
      const requestedCodexCli = canRunAgentic(plan, `${owner}/${repo}`, routingPolicy);
      const allowCodexCheckout = requestedCodexCli;
      if (
        (plan.modelTier === 'multi-model' || plan.modelTier === 'codex-hybrid') &&
        !requestedCodexCli
      ) {
        throw new Error(
          'high-tier review requires pinned Codex CLI Luna and a checkout-allowlisted repository',
        );
      }
      if (requestedCodexCli) {
        assertCodexRuntimeReady();
        if (!codexContainer)
          throw new Error('agentic Luna requires an injected internal Codex sandbox runtime');
        await codexContainer.assertReady(reviewAbortController.signal);
      }
      const wantInvestigate = canRunInvestigate(
        plan,
        { useCodexCli: requestedCodexCli },
        routingPolicy,
      );
      const investigateModel = wantInvestigate ? modelForInvestigate(config, routingPolicy) : null;
      const agentRepoDir =
        allowCodexCheckout || wantInvestigate
          ? await services.preparation.checkoutRepoForAgent(octokit, owner, repo, effectiveSha)
          : null;
      try {
        if (allowCodexCheckout && !agentRepoDir) {
          throw new Error(
            'agentic Luna repository checkout fetch failed; no substitute model was run',
          );
        }
        const useCodexCli = requestedCodexCli;
        const codexRepoDir = allowCodexCheckout ? agentRepoDir : null;
        if (codexRepoDir) {
          console.log(
            `[worker] codex repo sweep: checked out ${owner}/${repo}@${effectiveSha.slice(0, 7)}`,
          );
        } else if (wantInvestigate && agentRepoDir) {
          console.log(
            `[worker] investigate checkout: ${owner}/${repo}@${effectiveSha.slice(0, 7)}`,
          );
        } else if (wantInvestigate && !agentRepoDir) {
          console.warn('[worker] investigate skipped: repo checkout unavailable');
          skippedLenses.push('investigate (repository checkout unavailable)');
        }
        if (wantInvestigate && !investigateModel)
          skippedLenses.push('investigate (provider unavailable)');
        const { calls: reviewCalls, discoveryPasses } = scheduleReviewStages({
          job,
          plan,
          config,
          policy: executionPolicy,
          routing: routingPolicy,
          catalog: providerCatalog,
          useCodexCli,
          investigateModel,
          investigateCheckoutAvailable: Boolean(agentRepoDir),
          filesForLlm,
          highRiskDiff,
          context: reviewContext,
          skippedLenses,
        });

        const { calls: toRun, aggregation } = selectScheduledReviewCalls({
          calls: reviewCalls,
          discoveryPasses,
          maxCalls,
          plan,
          config,
          routing: routingPolicy,
          catalog: providerCatalog,
          requestedAggregation: executionPolicy.aggregation,
          skippedLenses,
        });
        {
          const sweepCount = toRun.filter((call) => call.kind === 'sweep').length;
          console.log(
            `[worker] review batch: ${toRun.length} calls (${toRun.length - sweepCount} pass calls + ${sweepCount} sweep), ` +
              `concurrency=${concurrency}${aggregation.enabled ? `, aggregation=${aggregation.effectiveRuns}x/${aggregation.minOccurrences}` : ''}`,
          );
        }

        // Provider-specific admission happens once for the complete required stack,
        // before any paid lane starts. If Luna is cooling, high-tier work waits but
        // lower tiers (which require only DeepSeek + MiniMax) remain independent.
        // This replaces the old shared review-stack circuit that stopped every plan.
        const requiredProviders = toRun
          .filter((call) => call.kind === 'pass' && !call.bestEffort)
          .map((call) => call.target.admissionBucket);
        await waitForProviderAvailability(
          requiredProviders,
          reviewAbortController.signal,
          config.providerAdmission,
        );

        const outcomes: ReviewCallOutcome[] = await executeReviewProviderCalls({
          calls: toRun,
          filesForLlm,
          filesForInvestigate,
          providers: providerRegistry,
          contextRun: runReview,
          repoDirectory: agentRepoDir,
          repoId: `${owner}/${repo}`,
          signal: reviewAbortController.signal,
          isCancelled: () => prClosedMidRun,
          getCodexThreadId: () => codexThreadId,
          setCodexThreadId: (threadId) => {
            codexThreadId = threadId;
          },
          onUsageFor,
          onAttemptFor,
          tagFindings,
          mapConcurrent: services.executor.mapConcurrent.bind(services.executor),
          apiConcurrency: concurrency,
        });

        if (prClosedMidRun) {
          console.log(
            `[worker] PR #${number} closed during review — discarding partial results, not posting`,
          );
          return {
            findingCount: 0,
            newCount: 0,
            fixedCount: 0,
            skipReason: 'pr_closed_mid_run',
            ...totalUsage(usage, usagePolicy),
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
        // If NO pass succeeded, NEVER post — regardless of how it failed. A systematic
        // error thrown before runLlmReview's own try (bad prompt build, an unmatched
        // provider error) surfaces as ok:false/transient:false/degraded:false on every
        // call; the old guard skipped those and posted a false "0 findings — clean"
        // review on a PR that was never actually reviewed. A real clean review has
        // ok:true calls, so it is still correctly distinguished.
        if (outcomes.length > 0 && okCount === 0) {
          const why =
            transientCount > 0
              ? 'rate-limit/transport errors (likely token-plan quota)'
              : degradedCount > 0
                ? 'unparseable model responses'
                : 'model calls errored before completing';
          throw new Error(
            `review aborted: all ${outcomes.length} model calls failed — ${why}. Will retry on the next push or \`@orvex review\`.`,
          );
        }

        // Every purchased discovery stage is required. In normal mode each needs
        // one completed call; in repeated mode each needs at least one successful
        // sample before aggregation. Explicit diagnostic/deep extras remain optional.
        const requiredCalls = toRun.filter((call) => call.kind === 'pass' && !call.bestEffort);
        const requiredLensIds = [
          ...new Set(requiredCalls.map((call) => call.modelPassIndex ?? -1)),
        ];
        // A required lens aborts the review only when it has ZERO successful
        // samples — the pre-aggregation semantics. Requiring minOccurrences
        // successes here aborted whole reviews (discarding every OTHER lens's
        // completed sample set and the sweep) whenever one model was flaky for
        // 4 of 5 samples, and a correlated TPM squeeze made the requeued retry
        // re-fire the identical burst into the same window. A lens with 1..min-1
        // successes instead DEGRADES below (posted with a disclosure): its
        // findings can still recur via other samples' lenses, and losing solo
        // findings to manual review beats losing the entire review.
        const requiredSuccesses = 1;
        const failedRequiredLenses = failedRequiredLensIds(
          requiredLensIds,
          outcomes,
          requiredSuccesses,
        );
        if (failedRequiredLenses.length > 0) {
          // PRESERVE TRANSIENCE. queue-runner decides whether to requeue by pattern-
          // matching this message with isTransientLlmError; naming it keeps a
          // rate-limited required lens retryable rather than silently partial.
          const failedRequiredPasses = outcomes.filter(
            (outcome) =>
              failedRequiredLenses.includes(outcome.modelPassIndex ?? -1) &&
              !outcome.bestEffort &&
              !outcome.ok,
          );
          const transientFailures = failedRequiredPasses.filter(
            (outcome) => outcome.transient,
          ).length;
          const cause =
            transientFailures > 0
              ? ' — required provider call timed out or was temporarily unavailable'
              : '; no partial review was posted';
          throw new Error(
            `review aborted: ${failedRequiredLenses.length}/${requiredLensIds.length} required review lens(es) ` +
              `completed fewer than ${requiredSuccesses} sample(s)${cause}`,
          );
        }
        const degradedRequired = outcomes
          .filter((o) => o.kind === 'pass' && !o.bestEffort && o.ok && o.degraded)
          .map((o) => `${o.label ?? 'required pass'} (degraded)`);
        if (degradedRequired.length > 0) {
          skippedLenses = [...new Set([...skippedLenses, ...degradedRequired])];
          console.warn(
            `[worker] required pass(es) degraded (${degradedRequired.join(', ')}) — posting with disclosure`,
          );
        }
        // `deep:` labels come from DEEP_EXTRA_ANGLES — the lenses the 2x charge buys.
        deepLensesRan = outcomes.some((o) => o.ok && (o.label ?? '').includes('deep:'));
        // Under aggregation a best-effort LENS is only "skipped" when EVERY sample
        // of it failed — one failed sample out of five must not brand a satisfied
        // review "(incomplete)" or list five duplicate per-sample labels.
        const sampleBase = (label: string | undefined): string =>
          (label ?? 'unnamed pass').replace(/ sample \d+\/\d+$/, '');
        const failedBestEffort = outcomes.filter((o) => o.kind === 'pass' && !o.ok && o.bestEffort);
        const okBestEffortBases = new Set(
          outcomes
            .filter((o) => o.kind === 'pass' && o.ok && o.bestEffort)
            .map((o) => sampleBase(o.label)),
        );
        const skippedBestEffort = aggregation.enabled
          ? [...new Set(failedBestEffort.map((o) => sampleBase(o.label)))].filter(
              (b) => !okBestEffortBases.has(b),
            )
          : failedBestEffort.map((o) => o.label ?? 'unnamed pass');
        if (skippedBestEffort.length > 0) {
          skippedLenses = [...new Set([...skippedLenses, ...skippedBestEffort])];
          console.warn(
            `[worker] ${skippedBestEffort.length} best-effort pass(es) failed (${skippedLenses.join(', ')}) — ` +
              `posting the review from the core passes that completed, WITH a disclosure banner`,
          );
        }
        if (aggregation.enabled) {
          // Aggregation degradation (see requiredSuccesses above): a required lens
          // with some but < minOccurrences successes can't reach the recurrence
          // gate on its own samples — disclose it rather than abort.
          const underSampled = requiredLensIds.filter((id) => {
            const okCount = outcomes.filter(
              (o) => (o.modelPassIndex ?? -1) === id && o.kind === 'pass' && !o.bestEffort && o.ok,
            ).length;
            return okCount >= 1 && okCount < aggregation.minOccurrences;
          });
          if (underSampled.length > 0) {
            const labels = underSampled.map((id) => {
              const ok = outcomes.filter(
                (o) =>
                  (o.modelPassIndex ?? -1) === id && o.kind === 'pass' && !o.bestEffort && o.ok,
              ).length;
              return `lens ${id + 1} (${ok}/${aggregation.effectiveRuns} samples)`;
            });
            skippedLenses = [...skippedLenses, ...labels];
            console.warn(
              `[worker] aggregation degraded — required lens(es) under-sampled: ${labels.join(', ')}; ` +
                'posting with a disclosure instead of aborting',
            );
          }
        }

        // Summary from the first successful REQUIRED pass — best-effort lenses
        // (investigate, deep extras, breadth) must not steal the PR headline.
        llmSummary =
          outcomes.find((o) => o.kind === 'pass' && o.ok && !o.bestEffort)?.summary ??
          outcomes.find((o) => o.kind === 'pass' && o.ok)?.summary ??
          llmSummary;
        for (const o of outcomes) accumulated.push(...o.findings);

        const dedupeFindings = (findings: ReviewFinding[]): ReviewFinding[] => {
          const severityRank: Record<string, number> = { P1: 3, P2: 2, P3: 1, info: 0 };
          const byFingerprint = new Map<string, ReviewFinding>();
          const order: string[] = [];
          for (const finding of findings) {
            const fp = fingerprintFinding(finding);
            const existing = byFingerprint.get(fp);
            if (existing) {
              mergeFindingProvenance(existing, finding);
              // Keep the strongest report, not the first — a later deep-dive P1 must
              // outrank an earlier general P3 with the same fingerprint.
              const existingRank = severityRank[existing.severity] ?? 0;
              const incomingRank = severityRank[finding.severity] ?? 0;
              if (
                incomingRank > existingRank ||
                (incomingRank === existingRank &&
                  (finding.confidence ?? 0) > (existing.confidence ?? 0))
              ) {
                byFingerprint.set(fp, {
                  ...finding,
                  provenance: existing.provenance ?? finding.provenance,
                });
                mergeFindingProvenance(byFingerprint.get(fp)!, existing);
              }
            } else {
              byFingerprint.set(fp, finding);
              order.push(fp);
            }
          }
          return order.map((fp) => byFingerprint.get(fp)!);
        };
        if (aggregation.enabled) {
          const isInvestigatePass = (idx: number | undefined) => idx === 100;
          const isRiskHuntPass = (idx: number | undefined) => typeof idx === 'number' && idx >= 101;
          const repeated = outcomes
            .filter(
              (outcome) =>
                outcome.kind === 'pass' &&
                outcome.ok &&
                !isInvestigatePass(outcome.modelPassIndex) &&
                !isRiskHuntPass(outcome.modelPassIndex),
            )
            .flatMap((outcome) =>
              outcome.findings.map((finding) => ({ sample: outcome.sample, finding })),
            );
          const mergedRepeated = await services.findingPipeline.aggregateRepeated(repeated, {
            minOccurrences: aggregation.minOccurrences,
            maxCandidates: aggregation.maxCandidates,
            mergeWithLlm: (system, user) =>
              providerRegistry.runText(llm, {
                system,
                user,
                temperature: aggregation.temperature,
                json: true,
                signal: reviewAbortController.signal,
                onUsage: onUsageFor(verificationTier, llm, 'aggregation'),
                onAttempt: onAttemptFor(verificationTier, 'aggregation'),
              }),
          });
          aggregationManualCandidates = mergedRepeated.reviewOnly;
          // Sweep, investigate, and risk-hunt are single-shot (not repeated) —
          // union them like sweep, otherwise unique tool-loop/risk evidence dies at
          // the recurrence threshold before the verifier can inspect it.
          const sweepFindings = outcomes
            .filter((outcome) => outcome.kind === 'sweep' && outcome.ok)
            .flatMap((outcome) => outcome.findings);
          const investigateFindings = outcomes
            .filter((outcome) => outcome.ok && isInvestigatePass(outcome.modelPassIndex))
            .flatMap((outcome) => outcome.findings);
          const riskHuntFindings = outcomes
            .filter((outcome) => outcome.ok && isRiskHuntPass(outcome.modelPassIndex))
            .flatMap((outcome) => outcome.findings);
          llmFindings = dedupeFindings([
            ...mergedRepeated.findings,
            ...sweepFindings,
            ...investigateFindings,
            ...riskHuntFindings,
          ]);
          console.log(
            `[worker] repeated aggregation ${mergedRepeated.usedLlmMerge ? 'LLM-merged' : 'fingerprint-fallback'}: ` +
              `${mergedRepeated.findings.length} recurring, ${mergedRepeated.reviewOnly.length} manual, ` +
              `${mergedRepeated.clusterCount} clusters` +
              (investigateFindings.length ? `, ${investigateFindings.length} investigate` : '') +
              (riskHuntFindings.length ? `, ${riskHuntFindings.length} risk-hunt` : ''),
          );
        } else {
          // Normal reviews union independently focused passes by stable fingerprint.
          llmFindings = dedupeFindings(accumulated);
        }
        // Don't let a failed first pass ("Review could not be completed…") headline
        // the review when later passes/sweep batches actually found bugs.
        if (llmFindings.length > 0 && llmSummary?.startsWith('Review could not be completed')) {
          llmSummary = undefined;
        }
        console.log(
          `[worker] review batch done: ${toRun.length} model calls, ${llmFindings.length} unique findings`,
        );
        // Pre-dedupe accumulation preserves multi-tier/lens overlap; unique merge
        // keeps only one survivor per fingerprint.
        const preVerifyContribution = summarizeModelContribution(accumulated);
        console.log(
          `[worker] model contribution (pre-dedupe): ${formatModelContribution(preVerifyContribution)}`,
        );
        const uniqueContribution = summarizeModelContribution(llmFindings);
        console.log(
          `[worker] model contribution (unique): ${formatModelContribution(uniqueContribution)}`,
        );
      } finally {
        services.finalization.cleanupCheckout(agentRepoDir);
      }
    }

    const merged = services.findingPipeline.mergeAndFilter({
      incoming: [...ruleFindings, ...llmFindings],
      priorOpen: verifiedOpen,
      headSha: effectiveSha,
      manualCandidates: aggregationManualCandidates,
      reviewedFiles: new Set(files.map((f) => f.filename)),
      priorReviewSha: priorState?.lastSha,
      protectedFingerprints: readErrorFps,
      suppressedFingerprints: config.store.getSuppressedFingerprints(installationId, owner, repo),
    });

    const verifyFiles = await services.findingPipeline.buildVerificationFiles({
      contextFiles: reviewContextFiles,
      changedFiles: filesForLlm,
      treePaths: repoTreePaths,
      deepVerify: plan.deepVerify,
      readFile: (filePath) => fetchFileContent(octokit, owner, repo, filePath, effectiveSha),
    });
    const verificationCandidates = [
      ...merged.toPost,
      ...merged.reviewOnly.map(({ finding }) => finding),
    ];
    const verification = await orchestrateVerification({
      candidates: verificationCandidates,
      toPost: merged.toPost,
      reviewOnly: merged.reviewOnly,
      files: verifyFiles,
      enabled: verificationEnabled,
      deepVerify: plan.deepVerify,
      target: llm,
      tier: verificationTier,
      signal: reviewAbortController.signal,
      providers: providerRegistry,
      findings: services.findingPipeline,
      onUsage: onUsageFor(verificationTier, llm, 'verification'),
      onAttempt: onAttemptFor(verificationTier, 'verification'),
    });
    merged.toPost = verification.toPost;
    merged.reviewOnly = verification.reviewOnly;
    console.log(
      `[worker] model contribution (posted): ${formatModelContribution(summarizeModelContribution(merged.toPost))}`,
    );

    const maxInlinePerPr = executionPolicy.maxInlinePerPr;
    const findings = services.findingPipeline.prepare({
      files,
      reviewConfig,
      priorFindings: priorState?.findings ?? [],
      verifiedFixed,
      toPost: merged.toPost,
      reviewOnly: merged.reviewOnly,
      newlyFixed: merged.newlyFixed,
      stillOpen: merged.stillOpen,
      maxInlinePerPr,
    });
    merged.toPost = findings.toPost;
    merged.reviewOnly = findings.reviewOnly;
    return services.publication.publishReview({
      job,
      config,
      runId,
      octokit,
      ref,
      owner,
      repo,
      number,
      installationId,
      tenantId,
      effectiveSha,
      plan,
      pr,
      coverage,
      filesForLlm,
      reviewContextFiles,
      priorState,
      codexThreadId,
      merged,
      findings,
      llmSummary,
      skippedLenses,
      verificationIncomplete: verification.incomplete,
      verificationUnavailableReason: verification.unavailableReason,
      usage,
      usagePolicy,
      deepLensesRan,
      signal: reviewAbortController.signal,
      policy: publicationPolicy,
      ownershipLost: () => runOwnershipLost,
      cancelForOwnershipLoss,
    });
  } finally {
    prStatePollingStopped = true;
    if (prStatePoll) clearTimeout(prStatePoll);
    services.finalization.cleanupCancellation({
      poll: ownershipHeartbeat,
      parentSignal,
      listener: cancelClosedReview,
    });
  }
}
