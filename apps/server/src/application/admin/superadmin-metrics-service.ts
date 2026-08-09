import type { BillingRepository, PlatformCost } from '@orvex-review/store';
import { planFeatures, publicPlanLabel } from '@orvex-review/tenants';
import { buildDeepScorecard } from '../../deep-scorecard.js';

export type SuperadminMetricsStore = Pick<
  BillingRepository,
  'deletePlatformCost' | 'getSuperadminCostAnalytics' | 'listScorecardRuns' | 'upsertPlatformCost'
>;

type CostAnalytics = ReturnType<SuperadminMetricsStore['getSuperadminCostAnalytics']>;
export type SuperadminCostView = Omit<CostAnalytics, 'overview' | 'byTenant'> & {
  overview: CostAnalytics['overview'] & {
    actualProfitUsd: number;
    actualMarginPct: number | null;
    actualNetProfitUsd: number;
    actualNetMarginPct: number | null;
    modeledProfitUsd: number;
    modeledRevenueForWindowUsd: number;
    modeledFixedCostForWindowUsd: number;
    modeledMarginPct: number | null;
    modeledNetProfitUsd: number;
    modeledNetMarginPct: number | null;
    telemetryCoveragePct: number;
  };
  byTenant: Array<
    CostAnalytics['byTenant'][number] & {
      planLabel: string;
      actualProfitUsd: number;
      actualMarginPct: number | null;
      modeledRevenueForWindowUsd: number;
      modeledProfitUsd: number;
    }
  >;
};

export class SuperadminMetricsService {
  constructor(private readonly store: SuperadminMetricsStore) {}

  costs(input: { since: string; until: string; recentLimit: number }): SuperadminCostView {
    const planPrices = Object.fromEntries(
      ['free', 'review', 'review-plus', 'verify-lite', 'verify', 'enterprise'].map((id) => [
        id,
        planFeatures(id).monthlyPriceCents ?? 0,
      ]),
    );
    const analytics = this.store.getSuperadminCostAnalytics(
      input.since,
      input.until,
      planPrices,
      input.recentLimit,
    );
    const rangeDays = Math.max(
      1 / 24,
      (Date.parse(input.until) - Date.parse(input.since)) / 86_400_000,
    );
    const windowFactor = rangeDays / 30;
    const modeledRevenueForWindowUsd = analytics.overview.modeledMonthlyRevenueUsd * windowFactor;
    const actualProfitUsd = analytics.overview.actualRevenueUsd - analytics.overview.costUsd;
    const modeledProfitUsd = modeledRevenueForWindowUsd - analytics.overview.costUsd;
    const actualNetProfitUsd = actualProfitUsd - analytics.overview.allocatedFixedCostUsd;
    const modeledFixedCostForWindowUsd = analytics.overview.monthlyFixedCostUsd * windowFactor;
    const modeledNetProfitUsd = modeledProfitUsd - modeledFixedCostForWindowUsd;
    return {
      ...analytics,
      overview: {
        ...analytics.overview,
        actualProfitUsd,
        actualMarginPct:
          analytics.overview.actualRevenueUsd > 0
            ? (actualProfitUsd / analytics.overview.actualRevenueUsd) * 100
            : null,
        actualNetProfitUsd,
        actualNetMarginPct:
          analytics.overview.actualRevenueUsd > 0
            ? (actualNetProfitUsd / analytics.overview.actualRevenueUsd) * 100
            : null,
        modeledProfitUsd,
        modeledRevenueForWindowUsd,
        modeledFixedCostForWindowUsd,
        modeledMarginPct:
          modeledRevenueForWindowUsd > 0
            ? (modeledProfitUsd / modeledRevenueForWindowUsd) * 100
            : null,
        modeledNetProfitUsd,
        modeledNetMarginPct:
          modeledRevenueForWindowUsd > 0
            ? (modeledNetProfitUsd / modeledRevenueForWindowUsd) * 100
            : null,
        telemetryCoveragePct:
          analytics.overview.runs > 0
            ? (analytics.overview.instrumentedRuns / analytics.overview.runs) * 100
            : 0,
      },
      byTenant: analytics.byTenant.map((row) => {
        const actualProfitUsd = row.actualRevenueUsd - row.costUsd;
        return {
          ...row,
          planLabel: publicPlanLabel(planFeatures(row.plan)),
          actualProfitUsd,
          actualMarginPct:
            row.actualRevenueUsd > 0 ? (actualProfitUsd / row.actualRevenueUsd) * 100 : null,
          modeledRevenueForWindowUsd: row.modeledMonthlyRevenueUsd * windowFactor,
          modeledProfitUsd: row.modeledMonthlyRevenueUsd * windowFactor - row.costUsd,
        };
      }),
    };
  }

  validateOperatingCost(input: {
    category?: string;
    amountCents?: number;
    note?: string;
  }): { kind: 'invalid' } | { kind: 'ok'; cost: PlatformCost } {
    const category = input.category?.trim().slice(0, 80);
    const amountCents = Number(input.amountCents);
    if (
      !category ||
      !/^[a-zA-Z0-9][a-zA-Z0-9 _./-]*$/.test(category) ||
      !Number.isFinite(amountCents) ||
      amountCents < 0 ||
      amountCents > 100_000_000
    ) {
      return { kind: 'invalid' };
    }
    return {
      kind: 'ok',
      cost: this.store.upsertPlatformCost({
        category,
        amountCents: Math.round(amountCents),
        note: input.note?.trim().slice(0, 240),
      }),
    };
  }

  removeOperatingCost(category: string): boolean {
    return this.store.deletePlatformCost(category);
  }
  deepScorecard() {
    return buildDeepScorecard(this.store.listScorecardRuns(1000));
  }
}
