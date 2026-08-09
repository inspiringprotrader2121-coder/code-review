import type { TenantBilling } from '../../types.js';
import type { BillingConnection } from './shared.js';

/** Tenant plan and subscription state. Pricing decisions remain in packages/billing. */
export class SqliteTenantSubscriptionRepository {
  constructor(private readonly db: BillingConnection) {}

  getTenantPlan(tenantId: string): string | null {
    const row = this.db.prepare(`SELECT plan FROM tenants WHERE id = ?`).get(tenantId) as
      | { plan?: string }
      | undefined;
    const plan = row?.plan ?? null;
    if (!plan || plan === 'free') return plan;
    const billing = this.getTenantBilling(tenantId);
    // Internal/default plans have no Stripe subscription to evaluate. Once a
    // tenant is Stripe-backed, only a current active or trialing subscription
    // can retain paid entitlements.
    if (!billing?.stripeSubscriptionId && !billing?.stripeSubscriptionStatus) return plan;
    return billing.stripeSubscriptionStatus === 'active' ||
      billing.stripeSubscriptionStatus === 'trialing'
      ? plan
      : 'free';
  }

  setTenantPlan(tenantId: string, plan: string): boolean {
    return (
      this.db.prepare(`UPDATE tenants SET plan = ? WHERE id = ?`).run(plan, tenantId).changes > 0
    );
  }

  getTenantBilling(tenantId: string): TenantBilling | null {
    const row = this.db
      .prepare(
        `SELECT stripe_customer_id, stripe_subscription_id, stripe_subscription_status,
              stripe_current_period_start, stripe_current_period_end
       FROM tenants WHERE id = ?`,
      )
      .get(tenantId) as SubscriptionRow | undefined;
    return row ? mapTenantBilling(row) : null;
  }

  setTenantBilling(tenantId: string, patch: TenantBilling): boolean {
    const existing = this.getTenantBilling(tenantId);
    if (!existing) return false;
    const next = { ...existing, ...patch };
    return (
      this.db
        .prepare(
          `UPDATE tenants
       SET stripe_customer_id = ?, stripe_subscription_id = ?, stripe_subscription_status = ?,
           stripe_current_period_start = ?, stripe_current_period_end = ?
       WHERE id = ?`,
        )
        .run(
          next.stripeCustomerId ?? null,
          next.stripeSubscriptionId ?? null,
          next.stripeSubscriptionStatus ?? null,
          next.stripeCurrentPeriodStart ?? null,
          next.stripeCurrentPeriodEnd ?? null,
          tenantId,
        ).changes > 0
    );
  }
}

interface SubscriptionRow {
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  stripe_subscription_status: string | null;
  stripe_current_period_start: string | null;
  stripe_current_period_end: string | null;
}

function mapTenantBilling(row: SubscriptionRow): TenantBilling {
  return {
    stripeCustomerId: row.stripe_customer_id ?? undefined,
    stripeSubscriptionId: row.stripe_subscription_id ?? undefined,
    stripeSubscriptionStatus: row.stripe_subscription_status ?? undefined,
    stripeCurrentPeriodStart: row.stripe_current_period_start ?? undefined,
    stripeCurrentPeriodEnd: row.stripe_current_period_end ?? undefined,
  };
}
