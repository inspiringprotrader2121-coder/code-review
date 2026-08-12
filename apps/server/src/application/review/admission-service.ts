import type { ReviewJobPayload } from '@orvex-review/queue';
import { planFeatures, type PlanFeatures } from '@orvex-review/tenants';
import type { WorkerConfig } from '../../review/worker-types.js';
import type { AdmissionResult } from './types.js';

export type ProviderIssue = (
  plan: PlanFeatures,
  config: WorkerConfig,
  repoId: string,
  installationId?: number,
) => string | null;
export type LimitNudge = (
  config: WorkerConfig,
  job: ReviewJobPayload,
  plan: PlanFeatures,
  reason:
    | 'rate_limited'
    | 'monthly_limit'
    | 'trial_exhausted'
    | 'cost_capped'
    | 'concurrency_limited'
    | 'insufficient_credits',
) => Promise<void>;
export type FailureNotice = (
  config: WorkerConfig,
  job: ReviewJobPayload,
  error: string,
) => Promise<void>;
export type CooldownNotice = (
  config: WorkerConfig,
  job: ReviewJobPayload,
  sinceSeconds: number,
  waitSeconds: number,
) => Promise<void>;

export interface AdmissionServiceDependencies {
  now?: () => number;
  providerIssue: ProviderIssue;
  accountLimitReason: (
    store: WorkerConfig['store'],
    account: string,
    plan: PlanFeatures,
    reviewCount: number,
    deepCount: number,
    request: { tenantId: string; deep: boolean },
  ) => string | null;
  prepaidOverageDebitCents: (
    store: WorkerConfig['store'],
    account: string,
    plan: PlanFeatures,
    deep: boolean,
    tenantId: string,
  ) => number;
  postLimitNudge: LimitNudge;
  postFailureNotice: FailureNotice;
  postCooldownNotice: CooldownNotice;
  cooldownSeconds?: () => number;
}

const skipped = (skipReason: string): AdmissionResult => ({
  kind: 'skipped',
  result: { findingCount: 0, newCount: 0, fixedCount: 0, skipReason },
});

/** Validates provider capacity and atomically reserves the billed review run. */
export class AdmissionService {
  constructor(private readonly dependencies: AdmissionServiceDependencies) {}

  async admit(job: ReviewJobPayload, config: WorkerConfig): Promise<AdmissionResult> {
    const startedAt = this.dependencies.now?.() ?? Date.now();
    const runBase = {
      tenantId: job.tenantId,
      installationId: job.installationId,
      owner: job.owner,
      repo: job.repo,
      pr: job.pr,
      headSha: job.headSha,
      action: job.action,
    };

    if (job.action === 'command' || job.action === 'manual') {
      const cooldownSeconds = this.dependencies.cooldownSeconds?.() ?? 120;
      const sinceSeconds = config.store.secondsSinceLastCompletedReview(
        job.installationId,
        job.owner,
        job.repo,
        job.pr,
        job.headSha,
      );
      if (sinceSeconds !== null && sinceSeconds < cooldownSeconds) {
        const waitSeconds = cooldownSeconds - sinceSeconds;
        config.store.recordReviewRun({
          ...runBase,
          status: 'skipped',
          skipReason: 'review_cooldown',
          durationMs: 0,
        });
        await this.dependencies.postCooldownNotice(config, job, sinceSeconds, waitSeconds);
        console.log(
          `[worker] cooldown: ${job.owner}/${job.repo}#${job.pr}@${job.headSha.slice(0, 7)} reviewed ${sinceSeconds}s ago (<${cooldownSeconds}s)`,
        );
        return skipped('review_cooldown');
      }
    }

    const plan = planFeatures(config.store.getTenantPlan(job.tenantId));
    const providerIssue = this.dependencies.providerIssue(
      plan,
      config,
      `${job.owner}/${job.repo}`,
      job.installationId,
    );
    if (providerIssue) {
      config.store.recordReviewRun({
        ...runBase,
        status: 'skipped',
        skipReason: 'provider_not_configured',
        durationMs: (this.dependencies.now?.() ?? Date.now()) - startedAt,
      });
      if (
        config.store.countRecentSkippedRuns(
          { installationId: job.installationId, owner: job.owner, repo: job.repo, pr: job.pr },
          'provider_not_configured',
          30 * 60_000,
        ) === 1
      ) {
        await this.dependencies.postFailureNotice(config, job, providerIssue);
      }
      return skipped('provider_not_configured');
    }

    const resumed = job.runId ? config.store.resumeReviewRun(job.runId, runBase) : 'unavailable';
    if (resumed === 'completed') return skipped('already_completed_after_restart');

    let runId: string;
    if (resumed === 'resumed') {
      runId = job.runId!;
      if (
        this.dependencies.accountLimitReason(config.store, job.owner, plan, 0, 1, {
          tenantId: job.tenantId,
          deep: Boolean(job.deep),
        }) === 'cost_capped'
      ) {
        config.store.completeReviewRun(runId, {
          status: 'skipped',
          skipReason: 'cost_capped',
          durationMs: (this.dependencies.now?.() ?? Date.now()) - startedAt,
        });
        config.store.refundOverageCredits(runId, 'refund: cost_capped on resume');
        await this.dependencies.postLimitNudge(config, job, plan, 'cost_capped');
        return skipped('cost_capped');
      }
    } else if (job.runId && job.resumedAfterRestart) {
      console.warn(
        `[worker] resume unavailable for interrupted run ${job.runId} on ${job.owner}/${job.repo}#${job.pr} — skipping without new reservation`,
      );
      config.store.refundOverageCredits(job.runId, 'refund: resume_unavailable');
      config.store.completeReviewRun(job.runId, {
        status: 'skipped',
        skipReason: 'resume_unavailable',
        durationMs: (this.dependencies.now?.() ?? Date.now()) - startedAt,
      });
      return skipped('resume_unavailable');
    } else {
      const reserved = config.store.tryReserveReviewRun(
        {
          ...runBase,
          deep: Boolean(job.deep),
          freeTier: plan.trialReviewLimit !== null,
          computeOverageDebit: () =>
            this.dependencies.prepaidOverageDebitCents(
              config.store,
              job.owner,
              plan,
              Boolean(job.deep),
              job.tenantId,
            ),
        },
        () =>
          this.dependencies.accountLimitReason(config.store, job.owner, plan, 1, 0, {
            tenantId: job.tenantId,
            deep: Boolean(job.deep),
          }),
      );
      if (!reserved.ok) {
        if (reserved.reason !== 'free_tier_capped') {
          await this.dependencies.postLimitNudge(
            config,
            job,
            plan,
            reserved.reason as Parameters<LimitNudge>[3],
          );
        }
        return skipped(reserved.reason);
      }
      runId = reserved.runId;
    }

    return { kind: 'admitted', review: { job, config, runId, startedAt, plan } };
  }
}
