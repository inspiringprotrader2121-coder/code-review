import type {
  ReviewRunStatus,
  ReviewRunUsage,
  ScorecardRun,
  SuperadminCostAnalytics,
} from '../../types.js';
import type { BillingConnection, BillingUsageLookup } from './shared.js';
import { parseNewFindings } from './shared.js';
import type { SqliteStripeRevenueRepository } from './stripe-revenue.js';

/** Read-only operator reporting over the immutable usage and revenue ledgers. */
export class SqliteBillingAnalyticsRepository {
  constructor(
    private readonly db: BillingConnection,
    private readonly usage: BillingUsageLookup,
    private readonly revenue: Pick<SqliteStripeRevenueRepository, 'listPlatformCosts'>,
  ) {}

  getSuperadminCostAnalytics(
    sinceIso: string,
    untilIso: string,
    planPricesCents: Record<string, number> = {},
    recentLimit = 100,
  ): SuperadminCostAnalytics {
    const runCostCte = `
      WITH run_costs AS (
        SELECT run_id, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
               SUM(cost_usd) AS cost_usd
        FROM review_run_usage WHERE created_at >= ? AND created_at < ? GROUP BY run_id
      )`;
    const rangeArgs = [sinceIso, untilIso];
    const overview = this.db
      .prepare(
        `${runCostCte}
       SELECT COUNT(*) AS runs,
              SUM(CASE WHEN r.status = 'completed' THEN 1 ELSE 0 END) AS completed_runs,
              SUM(CASE WHEN r.status = 'failed' THEN 1 ELSE 0 END) AS failed_runs,
              SUM(CASE WHEN r.status = 'skipped' AND IFNULL(r.skip_reason,'') != 'concurrency_limited' THEN 1 ELSE 0 END) AS skipped_runs,
              SUM(CASE WHEN rc.run_id IS NULL THEN r.input_tokens ELSE rc.input_tokens END) AS input_tokens,
              SUM(CASE WHEN rc.run_id IS NULL THEN r.output_tokens ELSE rc.output_tokens END) AS output_tokens,
              SUM(CASE WHEN rc.run_id IS NULL THEN r.cost_usd ELSE rc.cost_usd END) AS cost_usd,
              SUM(CASE WHEN rc.run_id IS NULL AND r.cost_usd > 0 THEN r.cost_usd ELSE 0 END) AS legacy_cost_usd,
              COUNT(CASE WHEN rc.run_id IS NOT NULL THEN 1 END) AS instrumented_runs,
              COUNT(CASE WHEN r.cost_usd > 0 OR rc.run_id IS NOT NULL THEN 1 END) AS runs_with_cost
       FROM review_runs r LEFT JOIN run_costs rc ON rc.run_id = r.id
       WHERE r.created_at >= ? AND r.created_at < ?
         AND NOT (r.status = 'skipped' AND r.skip_reason = 'concurrency_limited')`,
      )
      .get(...rangeArgs, ...rangeArgs) as OverviewRow;

    const revenueRows = this.db
      .prepare(
        `SELECT lower(currency) AS currency, COALESCE(SUM(amount_cents), 0) AS amount_cents
       FROM stripe_revenue_events WHERE occurred_at >= ? AND occurred_at < ? GROUP BY lower(currency)`,
      )
      .all(...rangeArgs) as CurrencyAmountRow[];
    const usdRevenue = revenueRows.find((row) => row.currency === 'usd');
    const nonUsdRevenue = revenueRows
      .filter((row) => row.currency !== 'usd')
      .map((row) => ({ currency: row.currency, amountCents: row.amount_cents }));
    const platformCosts = this.revenue.listPlatformCosts();
    const monthlyFixedCostUsd = platformCosts.reduce((sum, row) => sum + row.amountCents, 0) / 100;
    const allocatedFixedCostUsd =
      (monthlyFixedCostUsd *
        Math.max(1 / 24, (Date.parse(untilIso) - Date.parse(sinceIso)) / 86_400_000)) /
      30;

    const modelRows = this.db
      .prepare(
        `SELECT provider, model, tier, COUNT(*) AS calls, COUNT(DISTINCT run_id) AS runs,
              SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens, SUM(cost_usd) AS cost_usd
       FROM review_run_usage WHERE created_at >= ? AND created_at < ?
       GROUP BY provider, model, tier ORDER BY cost_usd DESC, model ASC`,
      )
      .all(...rangeArgs) as ModelRow[];
    const tenantRows = this.db
      .prepare(
        `${runCostCte}
       SELECT t.id AS tenant_id, t.slug, t.name, t.plan, t.stripe_subscription_status,
              COUNT(r.id) AS runs,
              SUM(CASE WHEN r.status = 'completed' THEN 1 ELSE 0 END) AS completed_runs,
              SUM(CASE WHEN r.status = 'failed' THEN 1 ELSE 0 END) AS failed_runs,
              SUM(CASE WHEN rc.run_id IS NULL THEN r.input_tokens ELSE rc.input_tokens END) AS input_tokens,
              SUM(CASE WHEN rc.run_id IS NULL THEN r.output_tokens ELSE rc.output_tokens END) AS output_tokens,
              SUM(CASE WHEN rc.run_id IS NULL THEN r.cost_usd ELSE rc.cost_usd END) AS cost_usd,
              COALESCE(revenue.amount_cents, 0) AS actual_revenue_cents
       FROM tenants t
       LEFT JOIN review_runs r ON r.tenant_id = t.id AND r.created_at >= ? AND r.created_at < ?
       LEFT JOIN run_costs rc ON rc.run_id = r.id
       LEFT JOIN (
         SELECT tenant_id, SUM(amount_cents) AS amount_cents FROM stripe_revenue_events
         WHERE occurred_at >= ? AND occurred_at < ? AND lower(currency) = 'usd' GROUP BY tenant_id
       ) revenue ON revenue.tenant_id = t.id
       GROUP BY t.id, revenue.amount_cents HAVING runs > 0 OR actual_revenue_cents != 0
       ORDER BY cost_usd DESC, t.slug ASC`,
      )
      .all(...rangeArgs, ...rangeArgs, ...rangeArgs) as TenantAnalyticsRow[];
    const modeledRevenue = (plan: string, status: string | null): number =>
      plan === 'free' ||
      status === null ||
      ['past_due', 'unpaid', 'canceled', 'incomplete', 'incomplete_expired'].includes(status)
        ? 0
        : (planPricesCents[plan] ?? 0) / 100;
    const modeledMonthlyRevenueUsd = (
      this.db.prepare(`SELECT plan, stripe_subscription_status FROM tenants`).all() as Array<{
        plan: string;
        stripe_subscription_status: string | null;
      }>
    ).reduce((sum, row) => sum + modeledRevenue(row.plan, row.stripe_subscription_status), 0);

    const dailyCosts = this.db
      .prepare(
        `${runCostCte}
       SELECT substr(r.created_at, 1, 10) AS day,
              SUM(CASE WHEN rc.run_id IS NULL THEN r.cost_usd ELSE rc.cost_usd END) AS cost_usd, COUNT(*) AS runs
       FROM review_runs r LEFT JOIN run_costs rc ON rc.run_id = r.id
       WHERE r.created_at >= ? AND r.created_at < ? GROUP BY day ORDER BY day ASC`,
      )
      .all(...rangeArgs, ...rangeArgs) as DailyCostRow[];
    const dailyRevenues = this.db
      .prepare(
        `SELECT substr(occurred_at, 1, 10) AS day, SUM(amount_cents) AS amount_cents
       FROM stripe_revenue_events WHERE occurred_at >= ? AND occurred_at < ? AND lower(currency) = 'usd' GROUP BY day`,
      )
      .all(...rangeArgs) as DailyRevenueRow[];
    const revenueByDay = new Map(dailyRevenues.map((row) => [row.day, row.amount_cents / 100]));
    const daily = dailyCosts.map((row) => ({
      day: row.day,
      costUsd: row.cost_usd ?? 0,
      actualRevenueUsd: revenueByDay.get(row.day) ?? 0,
      runs: row.runs,
    }));
    for (const row of dailyRevenues) {
      if (!revenueByDay.has(row.day) || !daily.some((day) => day.day === row.day)) {
        daily.push({ day: row.day, costUsd: 0, actualRevenueUsd: row.amount_cents / 100, runs: 0 });
      }
    }
    daily.sort((a, b) => a.day.localeCompare(b.day));

    const recentRows = this.db
      .prepare(
        `${runCostCte}
       SELECT r.*, rc.input_tokens AS usage_input_tokens, rc.output_tokens AS usage_output_tokens,
              rc.cost_usd AS usage_cost_usd
       FROM review_runs r LEFT JOIN run_costs rc ON rc.run_id = r.id
       WHERE r.created_at >= ? AND r.created_at < ?
         AND NOT (r.status = 'skipped' AND r.skip_reason = 'concurrency_limited')
       ORDER BY r.created_at DESC LIMIT ?`,
      )
      .all(...rangeArgs, ...rangeArgs, recentLimit) as RecentRunRow[];
    const usageByRun = new Map<string, ReviewRunUsage[]>();
    for (const row of recentRows) usageByRun.set(row.id, this.usage.listReviewRunUsage(row.id));

    return {
      since: sinceIso,
      until: untilIso,
      overview: {
        runs: overview.runs,
        completedRuns: overview.completed_runs ?? 0,
        failedRuns: overview.failed_runs ?? 0,
        skippedRuns: overview.skipped_runs ?? 0,
        inputTokens: overview.input_tokens ?? 0,
        outputTokens: overview.output_tokens ?? 0,
        costUsd: overview.cost_usd ?? 0,
        actualRevenueUsd: (usdRevenue?.amount_cents ?? 0) / 100,
        modeledMonthlyRevenueUsd,
        monthlyFixedCostUsd,
        allocatedFixedCostUsd,
        legacyCostUsd: overview.legacy_cost_usd ?? 0,
        instrumentedRuns: overview.instrumented_runs,
        runsWithCost: overview.runs_with_cost,
        nonUsdRevenue,
      },
      byModel: modelRows.map((row) => ({
        provider: row.provider,
        model: row.model,
        tier: row.tier,
        calls: row.calls,
        runs: row.runs,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        costUsd: row.cost_usd,
      })),
      byTenant: tenantRows.map((row) => ({
        tenantId: row.tenant_id,
        slug: row.slug,
        name: row.name,
        plan: row.plan,
        subscriptionStatus: row.stripe_subscription_status ?? undefined,
        runs: row.runs,
        completedRuns: row.completed_runs ?? 0,
        failedRuns: row.failed_runs ?? 0,
        inputTokens: row.input_tokens ?? 0,
        outputTokens: row.output_tokens ?? 0,
        costUsd: row.cost_usd ?? 0,
        actualRevenueUsd: row.actual_revenue_cents / 100,
        modeledMonthlyRevenueUsd: modeledRevenue(row.plan, row.stripe_subscription_status),
      })),
      daily,
      platformCosts,
      recentRuns: recentRows.map((row) => ({
        id: row.id,
        tenantId: row.tenant_id,
        installationId: row.installation_id,
        owner: row.owner,
        repo: row.repo,
        pr: row.pr,
        headSha: row.head_sha,
        action: row.action,
        status: row.status,
        skipReason: row.skip_reason ?? undefined,
        error: row.error ?? undefined,
        durationMs: row.duration_ms,
        findingsNew: row.findings_new,
        findingsFixed: row.findings_fixed,
        findingsOpen: row.findings_open,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        costUsd: row.cost_usd,
        deep: row.deep === 1,
        freeTier: row.free_tier === 1,
        newFindings: row.new_findings_json ? parseNewFindings(row.new_findings_json) : undefined,
        workerId: row.worker_id ?? undefined,
        heartbeatAt: row.heartbeat_at ?? undefined,
        completedAt: row.completed_at ?? undefined,
        createdAt: row.created_at,
        usage: usageByRun.get(row.id) ?? [],
        actualCostUsd: row.usage_cost_usd ?? row.cost_usd,
        legacyCost: row.usage_cost_usd === null,
      })),
    };
  }

  listScorecardRuns(limit = 500): ScorecardRun[] {
    const rows = this.db
      .prepare(
        `SELECT id, owner, repo, pr, head_sha, deep, duration_ms, cost_usd, created_at, new_findings_json
       FROM review_runs WHERE status = 'completed' ORDER BY created_at DESC LIMIT ?`,
      )
      .all(limit) as ScorecardRow[];
    return rows.reverse().map((row) => ({
      id: row.id,
      owner: row.owner,
      repo: row.repo,
      pr: row.pr,
      headSha: row.head_sha,
      deep: row.deep === 1,
      durationMs: row.duration_ms,
      costUsd: row.cost_usd,
      createdAt: row.created_at,
      newFindings: row.new_findings_json ? safeScorecardFindings(row.new_findings_json) : [],
    }));
  }
}

interface OverviewRow {
  runs: number;
  completed_runs: number | null;
  failed_runs: number | null;
  skipped_runs: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  legacy_cost_usd: number | null;
  instrumented_runs: number;
  runs_with_cost: number;
}
interface CurrencyAmountRow {
  currency: string;
  amount_cents: number;
}
interface ModelRow {
  provider: string;
  model: string;
  tier: string;
  calls: number;
  runs: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}
interface TenantAnalyticsRow {
  tenant_id: string;
  slug: string;
  name: string;
  plan: string;
  stripe_subscription_status: string | null;
  runs: number;
  completed_runs: number | null;
  failed_runs: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  actual_revenue_cents: number;
}
interface DailyCostRow {
  day: string;
  cost_usd: number | null;
  runs: number;
}
interface DailyRevenueRow {
  day: string;
  amount_cents: number;
}
interface RecentRunRow {
  id: string;
  tenant_id: string;
  installation_id: number;
  owner: string;
  repo: string;
  pr: number;
  head_sha: string;
  action: string;
  status: ReviewRunStatus;
  skip_reason: string | null;
  error: string | null;
  duration_ms: number;
  findings_new: number;
  findings_fixed: number;
  findings_open: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  deep: number;
  free_tier: number;
  new_findings_json: string | null;
  worker_id: string | null;
  heartbeat_at: string | null;
  completed_at: string | null;
  created_at: string;
  usage_cost_usd: number | null;
}
interface ScorecardRow {
  id: string;
  owner: string;
  repo: string;
  pr: number;
  head_sha: string;
  deep: number;
  duration_ms: number;
  cost_usd: number;
  created_at: string;
  new_findings_json: string | null;
}

function safeScorecardFindings(raw: string): ScorecardRun['newFindings'] {
  try {
    return JSON.parse(raw) as ScorecardRun['newFindings'];
  } catch {
    return [];
  }
}
