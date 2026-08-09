import type { PaidPlan } from './types.js';

const PAID_PLANS: readonly PaidPlan[] = ['review', 'review-plus', 'verify-lite', 'verify'];

/** Entitlement revision, deliberately independent of deployment Stripe IDs. */
export const PLAN_CATALOG_REVISION = '2026-08-09';

export interface BillingPlanFeatures {
  readonly id: string;
  readonly label: string;
  readonly includedReviewsPerMonth: number | null;
  readonly overageCentsPerReview: number | null;
}

export interface PlanSku {
  readonly id: PaidPlan;
  readonly revision: typeof PLAN_CATALOG_REVISION;
  readonly priceId?: string;
}

export interface PlanCatalogInput {
  readonly prices?: Readonly<Partial<Record<PaidPlan, string>>>;
  /** Accepted for backwards-compatible configuration loading; intentionally unused. */
  readonly meterNames?: Readonly<Partial<Record<PaidPlan, string>>>;
  readonly features: (plan: string | null | undefined) => BillingPlanFeatures;
}

export class PlanCatalog {
  constructor(private readonly input: PlanCatalogInput) {}

  checkoutPlans(): readonly PaidPlan[] {
    return PAID_PLANS;
  }
  isCheckoutPlan(value: string): value is PaidPlan {
    return (PAID_PLANS as readonly string[]).includes(value);
  }
  sku(plan: PaidPlan): PlanSku {
    return {
      id: plan,
      revision: PLAN_CATALOG_REVISION,
      priceId: this.input.prices?.[plan],
    };
  }
  features(plan: string | null | undefined): BillingPlanFeatures {
    return this.input.features(plan);
  }
}
