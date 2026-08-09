import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { AppDatabase } from '@orvex-review/store';
import {
  BillingApplication,
  PlanCatalog,
  PLAN_CATALOG_REVISION,
  UsageReservation,
  verifyStripeSignature,
} from './index.js';

const clock = { now: () => new Date('2026-08-09T12:00:00.000Z') };
const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
const catalog = new PlanCatalog({
  prices: {
    review: 'price_review',
    'review-plus': 'price_plus',
    'verify-lite': 'price_lite',
    verify: 'price_verify',
  },
  features: (plan) => {
    const matrix = {
      free: {
        id: 'free',
        label: 'Free',
        includedReviewsPerMonth: null,
        overageCentsPerReview: null,
      },
      review: {
        id: 'review',
        label: 'Review',
        includedReviewsPerMonth: 100,
        overageCentsPerReview: 50,
      },
      'review-plus': {
        id: 'review-plus',
        label: 'Review Plus',
        includedReviewsPerMonth: 500,
        overageCentsPerReview: null,
      },
      'verify-lite': {
        id: 'verify-lite',
        label: 'Verify Lite',
        includedReviewsPerMonth: 50,
        overageCentsPerReview: 75,
      },
      verify: {
        id: 'verify',
        label: 'Verify',
        includedReviewsPerMonth: 120,
        overageCentsPerReview: 150,
      },
    } as const;
    return matrix[(plan && plan in matrix ? plan : 'free') as keyof typeof matrix];
  },
});

function application(
  store: AppDatabase,
  fetcher: typeof fetch = async () =>
    Response.json({ url: 'https://checkout.stripe.test/session' }),
) {
  return new BillingApplication(
    store,
    {
      appBaseUrl: 'https://orvex.test',
      checkoutRateWindowMs: 60_000,
      checkoutRateMax: 12,
      creditPacksCents: [1000, 2500],
      stripe: {
        secretKey: 'sk_test',
        webhookSecrets: ['whsec_test'],
        webhookToleranceSeconds: 300,
      },
    },
    catalog,
    { http: fetcher, clock, logger, alert: async () => true },
  );
}

test('plan matrix has stable SKU revisions and prepaid overage remains in the wallet', () => {
  assert.deepEqual(catalog.checkoutPlans(), ['review', 'review-plus', 'verify-lite', 'verify']);
  for (const plan of catalog.checkoutPlans())
    assert.equal(catalog.sku(plan).revision, PLAN_CATALOG_REVISION);
  assert.equal(catalog.features('review').overageCentsPerReview, 50);
  assert.equal(catalog.features('verify').overageCentsPerReview, 150);
});

test('prepaid reservation lifecycle is tenant isolated and refund-idempotent', () => {
  const store = new AppDatabase(':memory:');
  const first = store.createTenant('first');
  const second = store.createTenant('second');
  const reservations = new UsageReservation(store);
  reservations.creditTopUp({
    tenantId: first.id,
    amountCents: 500,
    stripeSessionId: 'cs_first',
    note: 'first',
  });
  assert.equal(reservations.balanceCents(second.id), 0);
  assert.equal(
    reservations.reserveOverage({ tenantId: second.id, runId: 'second-run', amountCents: 50 }),
    false,
  );
  assert.equal(
    reservations.reserveOverage({ tenantId: first.id, runId: 'first-run', amountCents: 75 }),
    true,
  );
  assert.equal(reservations.refundUnusedReservation('first-run'), true);
  assert.equal(reservations.refundUnusedReservation('first-run'), false);
  assert.equal(reservations.balanceCents(first.id), 500);
});

test('verified webhook lifecycle applies a top-up exactly once through the durable claim', async () => {
  const store = new AppDatabase(':memory:');
  const tenant = store.createTenant('webhook');
  const billing = application(store);
  const event = {
    id: 'evt_credit',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_credit',
        customer: 'cus_credit',
        amount_total: 2500,
        payment_status: 'paid',
        metadata: { tenant_id: tenant.id, purpose: 'credit_topup' },
      },
    },
  };
  assert.equal(await billing.processWebhook(event), 'received');
  assert.equal(await billing.processWebhook(event), 'deduped');
  assert.equal(store.getCreditBalanceCents(tenant.id), 2500);
  assert.equal(store.getTenantBilling(tenant.id)?.stripeCustomerId, 'cus_credit');
});

test('paused subscriptions lose paid entitlement immediately', async () => {
  const store = new AppDatabase(':memory:');
  const tenant = store.createTenant('paused');
  store.setTenantPlan(tenant.id, 'verify');
  const billing = application(store);
  await billing.processWebhook({
    id: 'evt_paused',
    type: 'customer.subscription.updated',
    data: {
      object: {
        id: 'sub_paused',
        customer: 'cus_paused',
        status: 'paused',
        current_period_start: 1_786_320_000,
        current_period_end: 1_788_912_000,
        metadata: { tenant_id: tenant.id, plan: 'verify' },
      },
    },
  });
  assert.equal(store.getTenantPlan(tenant.id), 'free');
  assert.equal(store.getTenantBilling(tenant.id)?.stripeSubscriptionStatus, 'paused');
});

test('checkout stays in the one application path and binds its tenant metadata', async () => {
  const store = new AppDatabase(':memory:');
  const tenant = store.createTenant('checkout');
  let payload = '';
  const billing = application(store, async (_url, init) => {
    payload = String(init?.body);
    return Response.json({ url: 'https://checkout.stripe.test/session' });
  });
  assert.equal(
    await billing.checkout(tenant, 'review', 'idempotency-key'),
    'https://checkout.stripe.test/session',
  );
  const body = new URLSearchParams(payload);
  assert.equal(body.get('metadata[tenant_id]'), tenant.id);
  assert.equal(body.get('metadata[plan]'), 'review');
  assert.equal(body.get('line_items[0][price]'), 'price_review');
});

test('signature verification uses the injected clock and rejects stale signatures', () => {
  const body = '{"id":"evt"}';
  const secret = 'whsec_test';
  const timestamp = String(Math.floor(clock.now().getTime() / 1_000));
  const digest = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  assert.equal(
    verifyStripeSignature(body, `t=${timestamp},v1=${digest}`, secret, 300, clock),
    true,
  );
  assert.equal(verifyStripeSignature(body, `t=1,v1=${digest}`, secret, 300, clock), false);
});
