/**
 * Account review-quota status for PR comments (`@orvex rate limit`) and for
 * clearer blocked-nudge copy when a review is skipped for rate/monthly/trial.
 */
import type { BillingRepository } from '@orvex-review/store';
import { BillingPeriod } from '@orvex-review/billing';
import {
  publicPlanLabel,
  uncapPlan,
  isUnlimitedGithubOwner,
  type PlanFeatures,
} from '@orvex-review/tenants';
import { commandTrigger } from '@orvex-review/review';
import type { ServerConfig } from './bootstrap/config.js';

export const MS_PER_HOUR = 3_600_000;
export const MS_PER_30_DAYS = 30 * 24 * MS_PER_HOUR;

/** Monthly provider-cost circuit breaker. This is an operator safety ceiling,
 * not a customer-facing review allowance; set it after measuring real COGS.
 * Applies to every plan including enterprise — custom contracts still need a
 * spend backstop so a runaway cannot burn uncapped provider dollars.
 *
 * Prefer injecting `config.quota` (or account-limit policy). The string/plan-id
 * overload is legacy compatibility only and always returns the historical
 * default 250 — callers that need the live ORVEX_MONTHLY_COGS_CAP_USD must
 * pass the server config object. */
export function monthlyCogsCapUsd(configOrPlan?: Pick<ServerConfig, 'quota'> | string): number {
  // Review-pipeline migration owns the final caller. Its compatibility path
  // uses the historical default until it receives the injected server config.
  return typeof configOrPlan === 'object' ? configOrPlan.quota.monthlyCogsCapUsd : 250;
}

export type AccountQuotaStatus = {
  planId: string;
  planLabel: string;
  hourly: {
    used: number;
    limit: number | null;
    remaining: number | null;
    /** ISO time when the next hourly slot frees, if currently at/over the limit */
    nextSlotAt: string | null;
  };
  concurrent: {
    running: number;
    limit: number | null;
  };
  credits: {
    balanceCents: number;
    overageCentsPerReview: number | null;
  };
  monthly:
    | { kind: 'unlimited' }
    | { kind: 'hard'; used: number; limit: number; remaining: number }
    | { kind: 'metered'; used: number; included: number; overageCents: number };
  cost: { usedUsd: number; limitUsd: number | null };
  trial: { used: number; limit: number; remaining: number } | null;
};

/** Read-only quota projection required by commands and blocked-review copy. */
export type QuotaStatusStore = Pick<
  BillingRepository,
  | 'countAccountReviews'
  | 'countRunningAccountReviews'
  | 'countTenantReviewUnits'
  | 'getTenantBilling'
  | 'getCreditBalanceCents'
  | 'oldestAccountReviewCreatedAt'
  | 'sumAccountCost'
>;

export function loadAccountQuotaStatus(
  store: QuotaStatusStore,
  owner: string,
  tenantId: string,
  plan: PlanFeatures,
  config?: Pick<ServerConfig, 'quota'>,
  _now = Date.now(),
): AccountQuotaStatus {
  const resolved = isUnlimitedGithubOwner(owner) ? uncapPlan(plan) : plan;
  const hourlyUsed =
    resolved.reviewsPerHour !== null
      ? store.countAccountReviews(owner, { sinceMs: MS_PER_HOUR })
      : 0;
  let nextSlotAt: string | null = null;
  if (resolved.reviewsPerHour !== null && hourlyUsed >= resolved.reviewsPerHour) {
    const oldest = store.oldestAccountReviewCreatedAt(owner, MS_PER_HOUR);
    if (oldest) {
      nextSlotAt = new Date(new Date(oldest).getTime() + MS_PER_HOUR).toISOString();
    }
  }

  let monthly: AccountQuotaStatus['monthly'];
  const useTenantUnits =
    resolved.trialReviewLimit === null &&
    (resolved.includedReviewsPerMonth !== null || resolved.reviewsPerMonth !== null);
  const monthlyUsed = useTenantUnits
    ? store.countTenantReviewUnits(tenantId, {
        sinceIso: BillingPeriod.start(store.getTenantBilling(tenantId)?.stripeCurrentPeriodStart),
      })
    : store.countAccountReviews(owner, { sinceMs: MS_PER_30_DAYS });
  if (resolved.includedReviewsPerMonth !== null && resolved.overageCentsPerReview !== null) {
    monthly = {
      kind: 'metered',
      used: monthlyUsed,
      included: resolved.includedReviewsPerMonth,
      overageCents: resolved.overageCentsPerReview,
    };
  } else if (resolved.reviewsPerMonth !== null) {
    monthly = {
      kind: 'hard',
      used: monthlyUsed,
      limit: resolved.reviewsPerMonth,
      remaining: Math.max(0, resolved.reviewsPerMonth - monthlyUsed),
    };
  } else {
    monthly = { kind: 'unlimited' };
  }
  const cost = store.sumAccountCost(owner, MS_PER_30_DAYS);
  const costLimit = isUnlimitedGithubOwner(owner)
    ? Number.POSITIVE_INFINITY
    : monthlyCogsCapUsd(config);

  let trial: AccountQuotaStatus['trial'] = null;
  if (resolved.trialReviewLimit !== null) {
    const used = store.countAccountReviews(owner);
    trial = {
      used,
      limit: resolved.trialReviewLimit,
      remaining: Math.max(0, resolved.trialReviewLimit - used),
    };
  }

  return {
    planId: resolved.id,
    planLabel: publicPlanLabel(resolved),
    hourly: {
      used: hourlyUsed,
      limit: resolved.reviewsPerHour,
      remaining:
        resolved.reviewsPerHour === null ? null : Math.max(0, resolved.reviewsPerHour - hourlyUsed),
      nextSlotAt,
    },
    concurrent: {
      running: store.countRunningAccountReviews(owner),
      limit: resolved.maxConcurrentReviews,
    },
    credits: {
      balanceCents: store.getCreditBalanceCents(tenantId),
      overageCentsPerReview: resolved.overageCentsPerReview,
    },
    monthly,
    cost: { usedUsd: cost.costUsd, limitUsd: costLimit },
    trial,
  };
}

function formatRelativeWait(iso: string, now = Date.now()): string {
  const ms = new Date(iso).getTime() - now;
  if (ms <= 0) return 'now';
  const mins = Math.max(1, Math.ceil(ms / 60_000));
  if (mins < 60) return `~${mins} min`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem === 0 ? `~${hours}h` : `~${hours}h ${rem}m`;
}

function formatUsdCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function formatMonthlyLine(monthly: AccountQuotaStatus['monthly']): string {
  if (monthly.kind === 'unlimited') return '**Monthly:** unlimited (no monthly quota on this plan)';
  if (monthly.kind === 'hard') {
    return `**Monthly (hard cap):** ${monthly.used} / ${monthly.limit} used · **${monthly.remaining}** left`;
  }
  const over = Math.max(0, monthly.used - monthly.included);
  if (over > 0) {
    return (
      `**Monthly included:** ${monthly.used} / ${monthly.included} units used · ` +
      `**${over}** overage unit${over === 1 ? '' : 's'} at ${formatUsdCents(monthly.overageCents)}/review`
    );
  }
  return (
    `**Monthly included:** ${monthly.used} / ${monthly.included} units used · ` +
    `**${monthly.included - monthly.used}** included left (then ${formatUsdCents(monthly.overageCents)}/review)`
  );
}

function formatHourlyLine(hourly: AccountQuotaStatus['hourly'], now = Date.now()): string {
  if (hourly.limit === null) return '**Hourly:** unlimited';
  const base = `**Hourly:** ${hourly.used} / ${hourly.limit} used · **${hourly.remaining ?? 0}** left`;
  if (hourly.remaining === 0 && hourly.nextSlotAt) {
    return `${base} · next slot in ${formatRelativeWait(hourly.nextSlotAt, now)}`;
  }
  return base;
}

/** Status reply for `@orvex rate limit` — never starts a review. */
export function formatQuotaStatusComment(
  status: AccountQuotaStatus,
  trigger = commandTrigger(),
  now = Date.now(),
): string {
  const lines = [
    `## Orvex rate limit`,
    '',
    `**Plan:** ${status.planLabel}`,
    formatHourlyLine(status.hourly, now),
    status.concurrent.limit === null
      ? '**Concurrent:** unlimited (worker capacity still applies)'
      : `**Concurrent:** ${status.concurrent.running} / ${status.concurrent.limit} in flight`,
    status.credits.overageCentsPerReview != null
      ? `**Prepaid overage wallet:** $${(status.credits.balanceCents / 100).toFixed(2)} · $${(status.credits.overageCentsPerReview / 100).toFixed(2)}/review past included`
      : '**Prepaid overage:** not on this plan (hard monthly total only)',
    formatMonthlyLine(status.monthly),
  ];
  if (status.cost.limitUsd !== null) {
    lines.push(
      `**Provider-cost safety:** $${status.cost.usedUsd.toFixed(2)} / $${status.cost.limitUsd.toFixed(2)} rolling 30-day ceiling`,
    );
  }
  if (status.trial) {
    lines.push(
      `**Free trial:** ${status.trial.used} / ${status.trial.limit} lifetime · **${status.trial.remaining}** left`,
    );
  }
  lines.push(
    '',
    'Automatic reviews on each push use this same allowance. Turn off **Run on each commit** in the Orvex dashboard if you do not want every push to spend a review.',
    '',
    `<sub>This command does not start a review. Use \`${trigger} review\` when you want one.</sub>`,
  );
  return lines.join('\n');
}

/** Clearer blocked-nudge when a review was skipped for quota. */
export function formatLimitBlockedComment(
  status: AccountQuotaStatus,
  reason:
    | 'rate_limited'
    | 'monthly_limit'
    | 'trial_exhausted'
    | 'cost_capped'
    | 'concurrency_limited'
    | 'insufficient_credits',
  trigger = commandTrigger(),
  now = Date.now(),
): string {
  const tip =
    `\n\nTip: comment \`${trigger} rate limit\` anytime to see remaining quota. ` +
    'If push storms are burning the hourly bucket, turn off **Run on each commit** in the Orvex dashboard (manual `' +
    trigger +
    ' review` still works).';

  if (reason === 'insufficient_credits') {
    const bal =
      status.credits.balanceCents > 0
        ? `Wallet balance: **$${(status.credits.balanceCents / 100).toFixed(2)}**.`
        : 'Wallet balance: **$0.00**.';
    const rate =
      status.credits.overageCentsPerReview != null
        ? ` Overage is **$${(status.credits.overageCentsPerReview / 100).toFixed(2)}**/review prepaid.`
        : '';
    return (
      `💳 **Orvex prepaid overage required** on the **${status.planLabel}** plan. ` +
      `Your included monthly reviews are used up. ${bal}${rate} ` +
      `Add credits in the [Orvex dashboard](https://useorvex.com/dashboard) (**Plan and billing → Buy credits**) before more reviews can run.` +
      tip
    );
  }

  if (reason === 'concurrency_limited' && status.concurrent.limit !== null) {
    return (
      `⏳ **Orvex concurrency limit reached** on the **${status.planLabel}** plan. ` +
      `Already running **${status.concurrent.running} / ${status.concurrent.limit}** reviews for this account. ` +
      `This push/command was **not** started — wait for an in-flight review to finish, then retry.` +
      tip
    );
  }

  if (reason === 'rate_limited') {
    const wait =
      status.hourly.nextSlotAt != null
        ? ` Next review slot opens in **${formatRelativeWait(status.hourly.nextSlotAt, now)}**.`
        : ' Try again after the rolling hour refreshes.';
    if (status.planId === 'free') {
      return (
        `⏳ **Orvex free trial — hourly limit reached.** ` +
        `Used **${status.hourly.used} / ${status.hourly.limit}** reviews in the last hour.` +
        wait +
        ` This push was **not** reviewed.` +
        ` [Upgrade](https://useorvex.com/#pricing) for higher limits.` +
        tip
      );
    }
    return (
      `⏳ **Orvex hourly limit reached** on the **${status.planLabel}** plan. ` +
      `Used **${status.hourly.used} / ${status.hourly.limit}** reviews in the last hour.` +
      wait +
      ` This push/command was **not** reviewed.` +
      tip
    );
  }

  if (reason === 'monthly_limit' && status.monthly.kind === 'hard') {
    return (
      `⚠️ **Orvex monthly limit reached** on the **${status.planLabel}** plan. ` +
      `Used **${status.monthly.used} / ${status.monthly.limit}** reviews in the last 30 days. ` +
      `This review was **not** run. [Contact support](https://useorvex.com/#pricing) if you need a higher ceiling.` +
      tip
    );
  }

  if (reason === 'trial_exhausted' && status.trial) {
    return (
      `⚠️ **Orvex free trial used up.** This GitHub account has used all **${status.trial.limit}** free reviews ` +
      `(${status.trial.used} recorded). [Upgrade](https://useorvex.com/#pricing) to keep Orvex reviewing your PRs.` +
      tip
    );
  }

  if (reason === 'cost_capped' && status.cost.limitUsd !== null) {
    return (
      `🛑 **Orvex monthly safety ceiling reached** on the **${status.planLabel}** plan. ` +
      `Recorded provider cost is approximately **$${status.cost.usedUsd.toFixed(2)} / $${status.cost.limitUsd.toFixed(2)}** ` +
      `in the rolling 30-day window, so this review was **not** started. ` +
      `Contact support to review the ceiling or billing.` +
      tip
    );
  }

  // Fallback — should be rare (e.g. monthly_limit without hard monthly shape).
  return (
    `⏳ **Orvex limit reached** on the **${status.planLabel}** plan. This review was **not** run.` +
    tip
  );
}
