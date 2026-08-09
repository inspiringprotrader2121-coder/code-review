import type { PlanCatalog } from './plan-catalog.js';

export class EntitlementPolicy {
  constructor(
    private readonly catalog: PlanCatalog,
    private readonly creditPacksCents: readonly number[],
  ) {}
  canBuyPrepaidCredits(plan: string | null | undefined): boolean {
    return this.catalog.features(plan).overageCentsPerReview !== null;
  }
  isCreditPack(amountCents: number): boolean {
    return Number.isInteger(amountCents) && this.creditPacksCents.includes(amountCents);
  }
  unavailableCreditMessage(): string {
    return 'Prepaid credits are available only on plans with prepaid review overage.';
  }
  creditSnapshot(plan: string | null | undefined, balanceCents: number) {
    const features = this.catalog.features(plan);
    const creditsAvailable = features.overageCentsPerReview !== null;
    return {
      balanceCents,
      packsCents: creditsAvailable ? [...this.creditPacksCents] : [],
      overageCentsPerReview: features.overageCentsPerReview,
      creditsAvailable,
    };
  }
}
