import { BillingEventProcessor, type StripeEventResult } from './billing-event-processor.js';
import { BillingPeriod } from './billing-period.js';
import { EntitlementPolicy } from './entitlement-policy.js';
import type { PlanCatalog } from './plan-catalog.js';
import type { BillingStore } from './ports.js';
import { StripeGateway } from './stripe-gateway.js';
import {
  BillingError,
  type BillingDependencies,
  type BillingWorkspace,
  type PaidPlan,
  type StripeWebhookEvent,
} from './types.js';
import { UsageReservation } from './usage-reservation.js';

export interface BillingConfig {
  readonly appBaseUrl: string;
  readonly checkoutRateWindowMs: number;
  readonly checkoutRateMax: number;
  readonly creditPacksCents: readonly number[];
  readonly stripe: {
    readonly secretKey?: string;
    readonly webhookSecrets: readonly string[];
    readonly webhookToleranceSeconds: number;
  };
}

export class BillingApplication {
  readonly entitlements: EntitlementPolicy;
  readonly reservations: UsageReservation;
  readonly events: BillingEventProcessor;
  readonly stripe: StripeGateway;
  constructor(
    readonly store: BillingStore,
    readonly config: BillingConfig,
    readonly catalog: PlanCatalog,
    readonly deps: BillingDependencies,
  ) {
    this.entitlements = new EntitlementPolicy(catalog, config.creditPacksCents);
    this.reservations = new UsageReservation(store);
    this.stripe = new StripeGateway(config.stripe, deps.http, deps.clock);
    this.events = new BillingEventProcessor(store, this.stripe, catalog, deps);
  }
  creditSnapshot(tenantId: string) {
    return this.entitlements.creditSnapshot(
      this.store.getTenantPlan(tenantId) ?? 'free',
      this.reservations.balanceCents(tenantId),
    );
  }
  canBuyCredits(tenantId: string): boolean {
    return this.entitlements.canBuyPrepaidCredits(this.store.getTenantPlan(tenantId) ?? 'free');
  }
  async checkout(
    tenant: BillingWorkspace,
    plan: PaidPlan,
    idempotencyKey?: string,
  ): Promise<string> {
    if (!this.stripe.configured()) throw new BillingError('Stripe is not configured', 501);
    const sku = this.catalog.sku(plan);
    if (!sku.priceId) throw new BillingError(`missing Stripe price configuration for ${plan}`, 501);
    const params: Record<string, string> = {
      mode: 'subscription',
      'line_items[0][price]': sku.priceId,
      'line_items[0][quantity]': '1',
      success_url: `${this.config.appBaseUrl}/dashboard/${encodeURIComponent(tenant.slug)}?billing=success`,
      cancel_url: `${this.config.appBaseUrl}/dashboard/${encodeURIComponent(tenant.slug)}?billing=cancelled`,
      client_reference_id: tenant.id,
      'metadata[tenant_id]': tenant.id,
      'metadata[tenant_slug]': tenant.slug,
      'metadata[plan]': plan,
      'subscription_data[metadata][tenant_id]': tenant.id,
      'subscription_data[metadata][tenant_slug]': tenant.slug,
      'subscription_data[metadata][plan]': plan,
      allow_promotion_codes: 'true',
    };
    const billing = this.store.getTenantBilling(tenant.id);
    if (billing?.stripeCustomerId) params.customer = billing.stripeCustomerId;
    const session = await this.stripe.createCheckout(params, idempotencyKey);
    if (!session.url) throw new BillingError('Stripe did not return a checkout URL', 502);
    return session.url;
  }
  async topUpCredits(tenant: BillingWorkspace, amountCents: number): Promise<string> {
    if (!this.stripe.configured()) throw new BillingError('Stripe is not configured', 501);
    const dollars = (amountCents / 100).toFixed(2);
    const params: Record<string, string> = {
      mode: 'payment',
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][product_data][name]': `Orvex prepaid review credits ($${dollars})`,
      'line_items[0][price_data][product_data][description]':
        'Prepaid wallet balance for reviews past your plan included quota. Credits are non-refundable once used.',
      'line_items[0][price_data][unit_amount]': String(amountCents),
      'line_items[0][quantity]': '1',
      success_url: `${this.config.appBaseUrl}/dashboard/${encodeURIComponent(tenant.slug)}?billing=credits-success`,
      cancel_url: `${this.config.appBaseUrl}/dashboard/${encodeURIComponent(tenant.slug)}?billing=credits-cancelled`,
      client_reference_id: tenant.id,
      'metadata[tenant_id]': tenant.id,
      'metadata[tenant_slug]': tenant.slug,
      'metadata[purpose]': 'credit_topup',
      'metadata[amount_cents]': String(amountCents),
    };
    const billing = this.store.getTenantBilling(tenant.id);
    if (billing?.stripeCustomerId) params.customer = billing.stripeCustomerId;
    const session = await this.stripe.createCheckout(params);
    if (!session.url) throw new BillingError('Stripe did not return a checkout URL', 502);
    return session.url;
  }
  async portal(tenant: BillingWorkspace, customerId: string): Promise<string> {
    if (!this.stripe.configured()) throw new BillingError('Stripe is not configured', 501);
    const result = await this.stripe.createPortal({
      customer: customerId,
      return_url: `${this.config.appBaseUrl}/dashboard/${encodeURIComponent(tenant.slug)}`,
    });
    if (!result.url) throw new BillingError('Stripe did not return a billing portal URL', 502);
    return result.url;
  }
  webhookConfigured(): boolean {
    return this.config.stripe.webhookSecrets.length > 0;
  }
  verifyWebhookSignature(rawBody: string, signature: string | undefined): boolean {
    return this.stripe.verifyWebhookSignature(rawBody, signature);
  }
  parseWebhook(rawBody: string): StripeWebhookEvent | undefined {
    try {
      const event = JSON.parse(rawBody) as StripeWebhookEvent;
      return event && typeof event === 'object' && typeof event.type === 'string' && event.type
        ? event
        : undefined;
    } catch {
      return undefined;
    }
  }
  processWebhook(event: StripeWebhookEvent): Promise<StripeEventResult> {
    return this.events.process(event);
  }
  isCurrentSubscription(tenantId: string, subscriptionId: string | undefined): boolean {
    return this.events.isCurrentSubscription(tenantId, subscriptionId);
  }
  billingPeriodStart(tenantId: string): string {
    return BillingPeriod.start(
      this.store.getTenantBilling(tenantId)?.stripeCurrentPeriodStart,
      this.deps.clock.now(),
    );
  }
}

export function createBillingApplication(
  store: BillingStore,
  config: BillingConfig,
  catalog: PlanCatalog,
  deps: BillingDependencies,
): BillingApplication {
  return new BillingApplication(store, config, catalog, deps);
}
