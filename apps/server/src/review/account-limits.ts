import { planFeatures, isUnlimitedGithubOwner } from '@orvex-review/tenants';
import { BillingPeriod } from '@orvex-review/billing';
import type { WorkerConfig } from './worker-types.js';

const MS_PER_30_DAYS = 30 * 24 * 3_600_000;

function tenantQuotaPeriodStart(store: WorkerConfig['store'], tenantId: string): string {
  return BillingPeriod.start(store.getTenantBilling(tenantId)?.stripeCurrentPeriodStart);
}

export interface AccountLimitPolicy {
  freeTierDailyCap: number;
  cogsReservationUsd: number;
  /** Operator monthly provider-cost ceiling from ORVEX_MONTHLY_COGS_CAP_USD. */
  monthlyCogsCapUsd: number;
}

export const DEFAULT_ACCOUNT_LIMIT_POLICY: AccountLimitPolicy = {
  freeTierDailyCap: 300,
  cogsReservationUsd: 5,
  monthlyCogsCapUsd: 250,
};

export function createAccountLimitPolicy(values: Partial<AccountLimitPolicy>): AccountLimitPolicy {
  const daily = Number(values.freeTierDailyCap ?? DEFAULT_ACCOUNT_LIMIT_POLICY.freeTierDailyCap);
  const reservation = Number(
    values.cogsReservationUsd ?? DEFAULT_ACCOUNT_LIMIT_POLICY.cogsReservationUsd,
  );
  const monthlyCap = Number(
    values.monthlyCogsCapUsd ?? DEFAULT_ACCOUNT_LIMIT_POLICY.monthlyCogsCapUsd,
  );
  return {
    freeTierDailyCap:
      Number.isFinite(daily) && daily >= 1
        ? Math.min(Math.floor(daily), 1_000_000)
        : DEFAULT_ACCOUNT_LIMIT_POLICY.freeTierDailyCap,
    cogsReservationUsd:
      Number.isFinite(reservation) && reservation > 0
        ? Math.min(Math.max(reservation, 0.01), 1_000)
        : DEFAULT_ACCOUNT_LIMIT_POLICY.cogsReservationUsd,
    monthlyCogsCapUsd:
      Number.isFinite(monthlyCap) && monthlyCap > 0
        ? Math.min(Math.max(monthlyCap, 1), 1_000_000)
        : DEFAULT_ACCOUNT_LIMIT_POLICY.monthlyCogsCapUsd,
  };
}

export type AccountLimitReason =
  | 'rate_limited'
  | 'monthly_limit'
  | 'trial_exhausted'
  | 'free_tier_capped'
  | 'cost_capped'
  | 'concurrency_limited'
  | 'insufficient_credits';

export interface AccountLimitOptions {
  tenantId?: string;
  deep?: boolean;
  /** Nightly/scan/cmd: enforce COGS and optional concurrency, not PR quota. */
  cogsOnly?: boolean;
}

export function accountLimitReason(
  store: WorkerConfig['store'],
  owner: string,
  plan: ReturnType<typeof planFeatures>,
  pendingReservations = 1,
  excludedRunningReservations = 0,
  opts: AccountLimitOptions = {},
  policy: AccountLimitPolicy = DEFAULT_ACCOUNT_LIMIT_POLICY,
): AccountLimitReason | null {
  if (isUnlimitedGithubOwner(owner)) return null;
  if (!opts.cogsOnly) {
    if (plan.trialReviewLimit !== null) {
      const globalToday = store.countGlobalFreeTierReviewsSince(24 * 3_600_000);
      if (globalToday >= policy.freeTierDailyCap) {
        console.error(
          `[abuse] FREE-TIER DAILY CAP HIT: ${globalToday} free reviews in 24h (cap ${policy.freeTierDailyCap}). Pausing free reviews - likely trial-farming. Raise ORVEX_FREE_TIER_DAILY_CAP if this is genuine growth.`,
        );
        return 'free_tier_capped';
      }
    }
    if (
      plan.trialReviewLimit !== null &&
      store.countAccountReviews(owner) >= plan.trialReviewLimit
    ) {
      return 'trial_exhausted';
    }
    if (plan.maxConcurrentReviews !== null) {
      const running = store.countRunningAccountReviews(owner);
      const projected =
        Math.max(0, running - Math.max(0, excludedRunningReservations)) +
        Math.max(0, pendingReservations);
      if (projected > plan.maxConcurrentReviews) return 'concurrency_limited';
    }
    if (
      plan.reviewsPerHour !== null &&
      store.countAccountReviews(owner, { sinceMs: 3_600_000 }) >= plan.reviewsPerHour
    ) {
      return 'rate_limited';
    }

    const useTenantUnits =
      Boolean(opts.tenantId) &&
      plan.trialReviewLimit === null &&
      (plan.includedReviewsPerMonth !== null || plan.reviewsPerMonth !== null);
    const used = useTenantUnits
      ? store.countTenantReviewUnits(opts.tenantId!, {
          sinceIso: tenantQuotaPeriodStart(store, opts.tenantId!),
        })
      : store.countAccountReviews(owner, { sinceMs: MS_PER_30_DAYS });
    const pendingUnits = Math.max(0, pendingReservations) * (opts.deep ? 2 : 1);
    if (
      plan.reviewsPerMonth !== null &&
      used + (pendingReservations > 0 ? pendingUnits : 0) > plan.reviewsPerMonth
    ) {
      return 'monthly_limit';
    }
    const included = plan.includedReviewsPerMonth;
    if (included !== null && plan.overageCentsPerReview !== null && pendingReservations > 0) {
      const overageUnits = Math.max(0, used + pendingUnits - included);
      if (overageUnits > 0) {
        const need = plan.overageCentsPerReview * Math.min(pendingUnits, overageUnits);
        const balance = opts.tenantId ? store.getCreditBalanceCents(opts.tenantId) : 0;
        if (balance < need) return 'insufficient_credits';
      }
    } else if (
      included !== null &&
      plan.overageCentsPerReview === null &&
      used + (pendingReservations > 0 ? pendingUnits : 0) > included
    ) {
      return 'monthly_limit';
    }
  } else if (plan.maxConcurrentReviews !== null) {
    const running = store.countRunningAccountReviews(owner);
    const projected =
      Math.max(0, running - Math.max(0, excludedRunningReservations)) +
      Math.max(0, pendingReservations);
    if (projected > plan.maxConcurrentReviews) return 'concurrency_limited';
  }

  const costLimit = policy.monthlyCogsCapUsd;
  const accountCost = store.sumAccountCost(owner, MS_PER_30_DAYS).costUsd;
  const runningReviews = store.countRunningCogsReservations(owner, MS_PER_30_DAYS);
  const reservation = policy.cogsReservationUsd;
  const projectedReservations =
    Math.max(0, runningReviews - Math.max(0, excludedRunningReservations)) +
    Math.max(0, pendingReservations);
  const projectedCost = accountCost + reservation * projectedReservations;
  if (projectedCost >= costLimit) {
    console.error(
      `[billing] monthly COGS safety ceiling reached for ${owner}: ` +
        `$${projectedCost.toFixed(2)} projected (${Math.max(0, runningReviews - Math.max(0, excludedRunningReservations))} running + ${Math.max(0, pendingReservations)} pending) >= $${costLimit.toFixed(2)}`,
    );
    return 'cost_capped';
  }
  return null;
}

export function prepaidOverageDebitCents(
  store: WorkerConfig['store'],
  owner: string,
  plan: ReturnType<typeof planFeatures>,
  deep = false,
  tenantId?: string,
): number {
  if (plan.includedReviewsPerMonth === null || plan.overageCentsPerReview === null) return 0;
  const useTenantUnits = Boolean(tenantId) && plan.trialReviewLimit === null;
  const used = useTenantUnits
    ? store.countTenantReviewUnits(tenantId!, {
        sinceIso: tenantQuotaPeriodStart(store, tenantId!),
      })
    : store.countAccountReviews(owner, { sinceMs: MS_PER_30_DAYS });
  const units = deep ? 2 : 1;
  const overageUnits = Math.max(0, used + units - plan.includedReviewsPerMonth);
  if (overageUnits <= 0) return 0;
  return plan.overageCentsPerReview * Math.min(units, overageUnits);
}
