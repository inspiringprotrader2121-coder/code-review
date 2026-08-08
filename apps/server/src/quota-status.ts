/**
 * Account review-quota status for PR comments (`@orvex rate limit`) and for
 * clearer blocked-nudge copy when a review is skipped for rate/monthly/trial.
 */
import type { AppDatabase } from '@orvex-review/store';
import { publicPlanLabel, type PlanFeatures } from '@orvex-review/tenants';
import { commandTrigger } from '@orvex-review/review';

export const MS_PER_HOUR = 3_600_000;
export const MS_PER_30_DAYS = 30 * 24 * MS_PER_HOUR;

/** Monthly provider-cost circuit breaker. This is an operator safety ceiling,
 * not a customer-facing review allowance; set it after measuring real COGS.
 * Applies to every plan including enterprise — custom contracts still need a
 * spend backstop so a runaway cannot burn uncapped provider dollars. */
export function monthlyCogsCapUsd(_planId: string): number | null {
  const raw = process.env.ORVEX_MONTHLY_COGS_CAP_USD;
  const value = raw === undefined || raw.trim() === '' ? 250 : Number(raw);
  return Number.isFinite(value) && value > 0 ? value : 250;
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

export function loadAccountQuotaStatus(
  store: AppDatabase,
  owner: string,
  tenantId: string,
  plan: PlanFeatures,
  _now = Date.now(),
): AccountQuotaStatus {
  const hourlyUsed = plan.reviewsPerHour !== null ? store.countAccountReviews(owner, { sinceMs: MS_PER_HOUR }) : 0;
  let nextSlotAt: string | null = null;
  if (plan.reviewsPerHour !== null && hourlyUsed >= plan.reviewsPerHour) {
    const oldest = store.oldestAccountReviewCreatedAt(owner, MS_PER_HOUR);
    if (oldest) {
      nextSlotAt = new Date(new Date(oldest).getTime() + MS_PER_HOUR).toISOString();
    }
  }

  let monthly: AccountQuotaStatus['monthly'];
  const useTenantUnits =
    plan.trialReviewLimit === null &&
    (plan.includedReviewsPerMonth !== null || plan.reviewsPerMonth !== null);
  const monthlyUsed = useTenantUnits
    ? store.countTenantReviewUnits(tenantId, { sinceMs: MS_PER_30_DAYS })
    : store.countAccountReviews(owner, { sinceMs: MS_PER_30_DAYS });
  if (plan.includedReviewsPerMonth !== null && plan.overageCentsPerReview !== null) {
    // Included allotment + prepaid overage — show included usage; hard ceiling is
    // still enforced by accountLimitReason.
    monthly = {
      kind: 'metered',
      used: monthlyUsed,
      included: plan.includedReviewsPerMonth,
      overageCents: plan.overageCentsPerReview,
    };
  } else if (plan.reviewsPerMonth !== null) {
    monthly = {
      kind: 'hard',
      used: monthlyUsed,
      limit: plan.reviewsPerMonth,
      remaining: Math.max(0, plan.reviewsPerMonth - monthlyUsed),
    };
  } else {
    monthly = { kind: 'unlimited' };
  }
  const cost = store.sumAccountCost(owner, MS_PER_30_DAYS);
  const costLimit = monthlyCogsCapUsd(plan.id);

  let trial: AccountQuotaStatus['trial'] = null;
  if (plan.trialReviewLimit !== null) {
    const used = store.countAccountReviews(owner);
    trial = {
      used,
      limit: plan.trialReviewLimit,
      remaining: Math.max(0, plan.trialReviewLimit - used),
    };
  }

  return {
    planId: plan.id,
    planLabel: publicPlanLabel(plan),
    hourly: {
      used: hourlyUsed,
      limit: plan.reviewsPerHour,
      remaining:
        plan.reviewsPerHour === null ? null : Math.max(0, plan.reviewsPerHour - hourlyUsed),
      nextSlotAt,
    },
    concurrent: {
      running: store.countRunningAccountReviews(owner),
      limit: plan.maxConcurrentReviews,
    },
    credits: {
      balanceCents: store.getCreditBalanceCents(tenantId),
      overageCentsPerReview: plan.overageCentsPerReview,
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
    lines.push(`**Provider-cost safety:** $${status.cost.usedUsd.toFixed(2)} / $${status.cost.limitUsd.toFixed(2)} rolling 30-day ceiling`);
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
  reason: 'rate_limited' | 'monthly_limit' | 'trial_exhausted' | 'cost_capped' | 'concurrency_limited' | 'insufficient_credits',
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
    `⏳ **Orvex limit reached** on the **${status.planLabel}** plan. This review was **not** run.` + tip
  );
}
