import type { BillingRepository, TenancyRepository } from '@orvex-review/store';
import { isPlanId } from '@orvex-review/tenants';

export type TenantPlanStore = Pick<TenancyRepository, 'getTenantBySlug'> &
  Pick<BillingRepository, 'setTenantPlan'>;

export type TenantPlanChange =
  | { kind: 'invalid' | 'not_found' }
  | { kind: 'updated'; slug: string; plan: string };

/** Operator plan mutation rules, independent of the HTTP admin adapter. */
export class TenantPlanService {
  constructor(private readonly store: TenantPlanStore) {}

  setPlan(slug: string, plan: unknown): TenantPlanChange {
    if (typeof plan !== 'string' || !isPlanId(plan)) return { kind: 'invalid' };
    const tenant = this.store.getTenantBySlug(slug);
    if (!tenant) return { kind: 'not_found' };
    this.store.setTenantPlan(tenant.id, plan);
    return { kind: 'updated', slug: tenant.slug, plan };
  }
}
