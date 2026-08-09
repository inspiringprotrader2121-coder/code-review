import { BillingPeriod } from './billing-period.js';
import type { PlanCatalog } from './plan-catalog.js';
import type { BillingStore } from './ports.js';
import { StripeGateway, stripeId } from './stripe-gateway.js';
import type { BillingDependencies, PaidPlan, StripeWebhookEvent } from './types.js';
import { UsageReservation } from './usage-reservation.js';

export type StripeEventResult = 'received' | 'deduped' | 'processing';

/** Applies one verified Stripe event behind the durable webhook-claim boundary. */
export class BillingEventProcessor {
  private readonly reservations: UsageReservation;
  constructor(
    private readonly store: BillingStore,
    private readonly stripe: StripeGateway,
    private readonly catalog: PlanCatalog,
    private readonly deps: Pick<BillingDependencies, 'clock' | 'logger'>,
  ) {
    this.reservations = new UsageReservation(store);
  }
  async process(event: StripeWebhookEvent): Promise<StripeEventResult> {
    if (!event.id) throw new Error('Stripe event missing id');
    const claim = this.store.claimWebhookEvent('stripe', event.id);
    if (!claim)
      return this.store.getWebhookEvent('stripe', event.id)?.processedAt ? 'deduped' : 'processing';
    try {
      await this.apply(
        event as Required<Pick<StripeWebhookEvent, 'id' | 'type'>> & StripeWebhookEvent,
      );
      this.store.completeWebhookEvent('stripe', event.id, claim);
      return 'received';
    } catch (error) {
      this.store.releaseWebhookEvent('stripe', event.id, claim);
      throw error;
    }
  }
  private async apply(
    event: Required<Pick<StripeWebhookEvent, 'id' | 'type'>> & StripeWebhookEvent,
  ): Promise<void> {
    const object = event.data?.object;
    const tenantId = object?.metadata?.tenant_id;
    const plan = object?.metadata?.plan;
    if (event.type === 'checkout.session.completed') {
      if (object?.metadata?.purpose === 'credit_topup' && tenantId)
        this.applyCreditTopUp(tenantId, object);
      else if (tenantId && plan && this.catalog.isCheckoutPlan(plan))
        await this.applySubscriptionCheckout(tenantId, plan, object);
    }
    if (
      event.type === 'customer.subscription.created' ||
      event.type === 'customer.subscription.updated'
    ) {
      const current = tenantId ? this.store.getTenantBilling(tenantId) : undefined;
      const createdForDifferentSubscription =
        event.type === 'customer.subscription.created' &&
        Boolean(current?.stripeSubscriptionId) &&
        current?.stripeSubscriptionId !== object?.id;
      if (
        (event.type === 'customer.subscription.updated' || createdForDifferentSubscription) &&
        tenantId &&
        !this.isCurrentSubscription(tenantId, object?.id)
      ) {
        this.deps.logger.warn(
          `[billing] ignoring ${event.type} for superseded/early sub ${object?.id} (tenant ${tenantId})`,
        );
      } else if (tenantId && plan && this.catalog.isCheckoutPlan(plan)) {
        const customerId = stripeId(object?.customer);
        this.store.setTenantPlan(
          tenantId,
          BillingPeriod.unlocksPaidEntitlement(object?.status) ? plan : 'free',
        );
        this.store.setTenantBilling(tenantId, {
          stripeCustomerId: customerId,
          stripeSubscriptionId: object?.id,
          stripeSubscriptionStatus: object?.status,
          stripeCurrentPeriodStart: BillingPeriod.timestampToIso(object?.current_period_start),
          stripeCurrentPeriodEnd: BillingPeriod.timestampToIso(object?.current_period_end),
        });
        if (customerId) this.store.assignUnlinkedStripeRevenue(customerId, tenantId);
      }
    }
    if (event.type === 'customer.subscription.deleted' && tenantId) {
      if (!this.isCurrentSubscription(tenantId, object?.id))
        this.deps.logger.warn(
          `[billing] ignoring subscription.deleted for superseded sub ${object?.id} (tenant ${tenantId})`,
        );
      else {
        this.store.setTenantPlan(tenantId, 'free');
        this.store.setTenantBilling(tenantId, {
          stripeSubscriptionId: object?.id,
          stripeSubscriptionStatus: object?.status ?? 'canceled',
          stripeCurrentPeriodStart: BillingPeriod.timestampToIso(object?.current_period_start),
          stripeCurrentPeriodEnd: BillingPeriod.timestampToIso(object?.current_period_end),
        });
      }
    }
    if (event.type === 'invoice.paid' || event.type === 'charge.refunded')
      this.applyRevenueEvent(event, tenantId, object);
    if (event.type === 'charge.dispute.created' || event.type === 'charge.dispute.funds_withdrawn')
      this.applyDispute(tenantId, event.id, object);
  }
  private applyCreditTopUp(
    tenantId: string,
    object: NonNullable<StripeWebhookEvent['data']>['object'],
  ): void {
    const paymentStatus = object?.payment_status;
    if (paymentStatus && paymentStatus !== 'paid' && paymentStatus !== 'no_payment_required') {
      this.deps.logger.warn(
        `[billing] ignoring unpaid credit top-up session for tenant ${tenantId} (payment_status=${paymentStatus})`,
      );
      return;
    }
    const amountTotal = Number(object?.amount_total);
    const metadataAmount = Number(object?.metadata?.amount_cents);
    const amountCents =
      Number.isFinite(amountTotal) && amountTotal > 0
        ? amountTotal
        : Number.isFinite(metadataAmount) && metadataAmount > 0
          ? metadataAmount
          : NaN;
    const sessionId = stripeId(object?.id);
    const customerId = stripeId(object?.customer);
    if (!sessionId || !Number.isFinite(amountCents) || amountCents <= 0)
      throw new Error('Stripe credit top-up checkout is missing session id or amount');
    if (customerId) this.store.setTenantBilling(tenantId, { stripeCustomerId: customerId });
    const credited = this.reservations.creditTopUp({
      tenantId,
      amountCents: Math.floor(amountCents),
      stripeSessionId: sessionId,
      note: `prepaid overage top-up $${(amountCents / 100).toFixed(2)}`,
    });
    this.deps.logger.info(
      `[billing] credit top-up tenant=${tenantId} session=${sessionId} applied=${credited.applied} balance_cents=${credited.balanceCents}`,
    );
  }
  private async applySubscriptionCheckout(
    tenantId: string,
    plan: PaidPlan,
    object: NonNullable<StripeWebhookEvent['data']>['object'],
  ): Promise<void> {
    const newSubscription = stripeId(object?.subscription);
    const newCustomer = stripeId(object?.customer);
    if (!newSubscription || !newCustomer)
      throw new Error('Stripe checkout.session.completed is missing subscription or customer');
    const paymentStatus = object?.payment_status;
    if (paymentStatus && paymentStatus !== 'paid' && paymentStatus !== 'no_payment_required') {
      this.deps.logger.warn(
        `[billing] ignoring checkout.session.completed for unpaid session (payment_status=${paymentStatus}) tenant=${tenantId}`,
      );
      return;
    }
    const prior = this.store.getTenantBilling(tenantId);
    if (prior?.stripeSubscriptionId && prior.stripeSubscriptionId !== newSubscription) {
      try {
        await this.stripe.cancelSubscription(prior.stripeSubscriptionId);
      } catch (error) {
        this.deps.logger.error(
          `[billing] could not cancel superseded subscription ${prior.stripeSubscriptionId} for tenant ${tenantId}: ${(error as Error).message}`,
        );
        throw error;
      }
    }
    let subscriptionStatus = object?.status;
    let periodStart = BillingPeriod.timestampToIso(object?.current_period_start);
    let periodEnd = BillingPeriod.timestampToIso(object?.current_period_end);
    if (this.stripe.configured()) {
      try {
        const subscription = await this.stripe.getSubscription(newSubscription);
        subscriptionStatus = subscription.status ?? subscriptionStatus;
        periodStart =
          BillingPeriod.timestampToIso(subscription.current_period_start) ?? periodStart;
        periodEnd = BillingPeriod.timestampToIso(subscription.current_period_end) ?? periodEnd;
      } catch (error) {
        this.deps.logger.warn(
          `[billing] could not retrieve subscription ${newSubscription} on checkout complete: ${(error as Error).message}`,
        );
      }
    }
    if (!BillingPeriod.unlocksPaidEntitlement(subscriptionStatus)) {
      this.deps.logger.warn(
        `[billing] checkout complete but subscription status=${subscriptionStatus} - recording billing without plan unlock`,
      );
      this.store.setTenantBilling(tenantId, {
        stripeCustomerId: newCustomer,
        stripeSubscriptionId: newSubscription,
        stripeSubscriptionStatus: subscriptionStatus,
        stripeCurrentPeriodStart: periodStart,
        stripeCurrentPeriodEnd: periodEnd,
      });
    } else {
      this.store.setTenantPlan(tenantId, plan);
      this.store.setTenantBilling(tenantId, {
        stripeCustomerId: newCustomer,
        stripeSubscriptionId: newSubscription,
        stripeSubscriptionStatus: subscriptionStatus ?? 'active',
        stripeCurrentPeriodStart:
          periodStart ??
          BillingPeriod.timestampToIso(object?.created) ??
          this.deps.clock.now().toISOString(),
        stripeCurrentPeriodEnd: periodEnd,
      });
    }
    this.store.assignUnlinkedStripeRevenue(newCustomer, tenantId);
  }
  private applyRevenueEvent(
    event: StripeWebhookEvent & { id: string; type: string },
    tenantId: string | undefined,
    object: NonNullable<StripeWebhookEvent['data']>['object'],
  ): void {
    const customerId = stripeId(object?.customer);
    const revenueTenantId =
      tenantId ?? (customerId ? this.store.getTenantByStripeCustomerId(customerId)?.id : undefined);
    const chargeId = event.type === 'charge.refunded' ? object?.id : undefined;
    const cumulativeRefunded = Math.max(0, Number(object?.amount_refunded ?? 0));
    const refundDelta = Math.max(
      0,
      cumulativeRefunded - (chargeId ? this.store.sumStripeRefundsForCharge(chargeId) : 0),
    );
    const amountCents =
      event.type === 'invoice.paid' ? Math.max(0, Number(object?.amount_paid ?? 0)) : -refundDelta;
    if (amountCents !== 0) {
      if (!revenueTenantId)
        this.deps.logger.warn(
          `[billing] recording unlinked ${event.type} ${event.id}; it will be assigned when customer billing is linked`,
        );
      this.store.recordStripeRevenueEvent({
        eventId: event.id,
        eventType: event.type,
        invoiceId: object?.id,
        tenantId: revenueTenantId,
        customerId,
        subscriptionId: stripeId(object?.subscription),
        amountCents,
        currency: object?.currency ?? 'usd',
        occurredAt:
          (event.type === 'charge.refunded'
            ? BillingPeriod.timestampToIso(event.created)
            : BillingPeriod.timestampToIso(object?.status_transitions?.paid_at)) ??
          this.deps.clock.now().toISOString(),
      });
    }
    if (event.type === 'charge.refunded' && revenueTenantId && refundDelta > 0) {
      const clawed = this.store.clawbackPrepaidCredits({
        tenantId: revenueTenantId,
        amountCents: refundDelta,
        stripeSessionId: `refund:${event.id}`,
        note: `clawback unused credits for Stripe charge refund ${chargeId ?? ''}`.trim(),
      });
      this.deps.logger.info(
        `[billing] credit clawback tenant=${revenueTenantId} event=${event.id} clawed_cents=${clawed.clawedCents} balance_cents=${clawed.balanceCents}`,
      );
    }
  }
  private applyDispute(
    tenantId: string | undefined,
    eventId: string,
    object: NonNullable<StripeWebhookEvent['data']>['object'],
  ): void {
    const customerId = stripeId(object?.customer);
    const disputeTenantId =
      tenantId ?? (customerId ? this.store.getTenantByStripeCustomerId(customerId)?.id : undefined);
    const amount = Math.max(0, Number(object?.amount ?? 0));
    const disputeId = stripeId(object?.id) ?? eventId;
    if (!disputeTenantId || amount <= 0 || !disputeId) return;
    const clawed = this.store.clawbackPrepaidCredits({
      tenantId: disputeTenantId,
      amountCents: amount,
      stripeSessionId: `dispute:${disputeId}`,
      note: `clawback unused credits for Stripe dispute ${disputeId}`,
    });
    this.deps.logger.info(
      `[billing] credit dispute clawback tenant=${disputeTenantId} dispute=${disputeId} clawed_cents=${clawed.clawedCents} balance_cents=${clawed.balanceCents}`,
    );
  }
  isCurrentSubscription(tenantId: string, subscriptionId: string | undefined): boolean {
    return (
      Boolean(subscriptionId) &&
      (!this.store.getTenantBilling(tenantId)?.stripeSubscriptionId ||
        this.store.getTenantBilling(tenantId)?.stripeSubscriptionId === subscriptionId)
    );
  }
}
