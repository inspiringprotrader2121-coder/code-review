import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AppDatabase } from '@orvex-review/store';
import {
  billingRoutes as createBillingRoutes,
  isCurrentSubscription as isCurrentSubscriptionWithConfig,
  verifyStripeSignature as verifyStripeSignatureWithConfig,
} from './billing.js';
import {
  testAppDatabase,
  testRouteDependencies,
  testServerConfig,
} from '../bootstrap/test-config.js';

test('verifies Stripe webhook signatures', () => {
  const body = JSON.stringify({ id: 'evt_test', type: 'checkout.session.completed' });
  const secret = 'whsec_test';
  // current timestamp — the tolerance check rejects stale signatures (replay guard)
  const timestamp = String(Math.floor(Date.now() / 1000));
  const digest = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');

  assert.equal(verifyStripeSignature(body, `t=${timestamp},v1=${digest}`, secret), true);
  assert.equal(verifyStripeSignature(body, `t=${timestamp},v1=rotated,v1=${digest}`, secret), true);
  assert.equal(verifyStripeSignature(body, `t=${timestamp},v1=bad`, secret), false);
  assert.equal(verifyStripeSignature(`${body}\n`, `t=${timestamp},v1=${digest}`, secret), false);
  // a stale (validly-signed) timestamp is rejected — no replay
  const old = String(Math.floor(Date.now() / 1000) - 10_000);
  const oldDigest = createHmac('sha256', secret).update(`${old}.${body}`).digest('hex');
  assert.equal(verifyStripeSignature(body, `t=${old},v1=${oldDigest}`, secret), false);
});

test('isCurrentSubscription guards deleted/updated events against superseded subs', () => {
  const db = new AppDatabase(':memory:');
  const tenant = db.createTenant('acme', 'Acme');

  // No stored subscription yet (brand-new tenant) → accept, nothing to conflict with.
  assert.equal(isCurrentSubscription(db, tenant.id, 'sub_new'), true);

  // After an upgrade the tenant points at the NEW sub — events naming it pass.
  db.setTenantBilling(tenant.id, { stripeSubscriptionId: 'sub_new' });
  assert.equal(isCurrentSubscription(db, tenant.id, 'sub_new'), true);

  // The canceled OLD sub's deleted/updated events must be ignored (this was the
  // "upgrade → immediately downgraded to free" bug).
  assert.equal(isCurrentSubscription(db, tenant.id, 'sub_old'), false);

  // A missing event sub id never matches.
  assert.equal(isCurrentSubscription(db, tenant.id, undefined), false);
});

test('checkout completion restores paid access, seeds the billing period, and dedupes durable delivery', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'orvex-billing-webhook-'));
  const previous = snapshotEnv([
    'STORE_PATH',
    'PLATFORM_SECRET',
    'STRIPE_WEBHOOK_SECRET',
    'STRIPE_SECRET_KEY',
    'APP_URL',
  ]);
  t.after(() => {
    restoreEnv(previous);
    rmSync(dir, { recursive: true, force: true });
  });
  process.env.STORE_PATH = path.join(dir, 'app.db');
  process.env.PLATFORM_SECRET = 'test-platform-secret';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
  process.env.STRIPE_SECRET_KEY = 'sk_test';
  process.env.APP_URL = 'https://example.test';

  const db = testAppDatabase();
  const tenant = db.createTenant('dunning-workspace');
  db.setTenantPlan(tenant.id, 'review');
  db.setTenantBilling(tenant.id, {
    stripeSubscriptionId: 'sub_old',
    stripeSubscriptionStatus: 'past_due',
  });
  const created = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({
    id: 'evt_checkout_recovery',
    type: 'checkout.session.completed',
    data: {
      object: {
        metadata: { tenant_id: tenant.id, plan: 'review' },
        customer: 'cus_new',
        subscription: 'sub_new',
        created,
      },
    },
  });
  const signature = stripeSignature(body, 'whsec_test');
  const originalFetch = globalThis.fetch;
  let cancelCalls = 0;
  globalThis.fetch = async (input: string | URL | Request) => {
    cancelCalls += 1;
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/v1/subscriptions/')) {
      return Response.json({
        status: 'active',
        current_period_start: created,
        current_period_end: created + 30 * 24 * 3600,
      });
    }
    return Response.json({ ok: true });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const app = billingRoutes();
  const request = () =>
    app.request('/webhooks/stripe', {
      method: 'POST',
      headers: { 'stripe-signature': signature },
      body,
    });

  const first = await request();
  assert.equal(first.status, 200);
  assert.equal(db.getTenantPlan(tenant.id), 'review');
  const billing = db.getTenantBilling(tenant.id)!;
  assert.equal(billing.stripeSubscriptionStatus, 'active');
  assert.equal(billing.stripeSubscriptionId, 'sub_new');
  assert.equal(billing.stripeCurrentPeriodStart, new Date(created * 1000).toISOString());
  // Cancel superseded sub + retrieve new subscription status/period.
  assert.equal(cancelCalls, 2);

  const duplicate = await request();
  assert.equal(duplicate.status, 200);
  assert.deepEqual(await duplicate.json(), { received: true, deduped: true });
  assert.equal(cancelCalls, 2, 'durable dedupe prevents a second subscription cancellation');
});

test('subscription.created does not repoint an existing subscription before checkout completes', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'orvex-billing-sub-created-'));
  const previous = snapshotEnv(['STORE_PATH', 'PLATFORM_SECRET', 'STRIPE_WEBHOOK_SECRET']);
  t.after(() => {
    restoreEnv(previous);
    rmSync(dir, { recursive: true, force: true });
  });
  process.env.STORE_PATH = path.join(dir, 'app.db');
  process.env.PLATFORM_SECRET = 'test-platform-secret';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_created';

  const db = testAppDatabase();
  const tenant = db.createTenant('created-race');
  db.setTenantBilling(tenant.id, {
    stripeCustomerId: 'cus_old',
    stripeSubscriptionId: 'sub_old',
    stripeSubscriptionStatus: 'active',
  });
  const body = JSON.stringify({
    id: 'evt_subscription_created_race',
    type: 'customer.subscription.created',
    data: {
      object: {
        id: 'sub_new',
        customer: 'cus_new',
        status: 'active',
        metadata: { tenant_id: tenant.id, plan: 'review' },
      },
    },
  });
  const response = await billingRoutes().request('/webhooks/stripe', {
    method: 'POST',
    headers: { 'stripe-signature': stripeSignature(body, 'whsec_created') },
    body,
  });
  assert.equal(response.status, 200);
  assert.equal(db.getTenantBilling(tenant.id)?.stripeSubscriptionId, 'sub_old');
});

test('invoice payments become durable revenue events and webhook retries do not double-count', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'orvex-billing-revenue-'));
  const previous = snapshotEnv(['STORE_PATH', 'PLATFORM_SECRET', 'STRIPE_WEBHOOK_SECRET']);
  t.after(() => {
    restoreEnv(previous);
    rmSync(dir, { recursive: true, force: true });
  });
  process.env.STORE_PATH = path.join(dir, 'app.db');
  process.env.PLATFORM_SECRET = 'test-platform-secret';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_revenue';

  const db = testAppDatabase();
  const tenant = db.createTenant('revenue-workspace');
  db.setTenantBilling(tenant.id, { stripeCustomerId: 'cus_revenue' });
  const created = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({
    id: 'evt_invoice_paid',
    type: 'invoice.paid',
    created,
    data: {
      object: {
        id: 'in_revenue',
        customer: 'cus_revenue',
        subscription: 'sub_revenue',
        amount_paid: 9900,
        currency: 'usd',
        status_transitions: { paid_at: created },
      },
    },
  });
  const signature = stripeSignature(body, 'whsec_revenue');
  const app = billingRoutes();
  const request = () =>
    app.request('/webhooks/stripe', {
      method: 'POST',
      headers: { 'stripe-signature': signature },
      body,
    });

  assert.equal((await request()).status, 200);
  const analytics = db.getSuperadminCostAnalytics(
    new Date((created - 60) * 1000).toISOString(),
    new Date((created + 60) * 1000).toISOString(),
  );
  assert.equal(analytics.overview.actualRevenueUsd, 99);
  assert.equal((await request()).status, 200);
  assert.equal(
    db.getSuperadminCostAnalytics(
      new Date((created - 60) * 1000).toISOString(),
      new Date((created + 60) * 1000).toISOString(),
    ).overview.actualRevenueUsd,
    99,
  );
});

test('billing checkout is owner-only and throttled without contacting Stripe', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'orvex-billing-auth-'));
  const previous = snapshotEnv([
    'STORE_PATH',
    'PLATFORM_SECRET',
    'APP_URL',
    'ORVEX_REQUIRE_LOGIN',
    'STRIPE_SECRET_KEY',
    'STRIPE_PRICE_REVIEW',
    'STRIPE_PRICE_REVIEW_OVERAGE',
  ]);
  t.after(() => {
    restoreEnv(previous);
    rmSync(dir, { recursive: true, force: true });
  });
  process.env.STORE_PATH = path.join(dir, 'app.db');
  process.env.PLATFORM_SECRET = 'test-platform-secret-that-is-not-used-in-production';
  process.env.APP_URL = 'https://example.test';
  process.env.ORVEX_REQUIRE_LOGIN = '1';
  process.env.STRIPE_SECRET_KEY = 'sk_test_no_network';
  process.env.STRIPE_PRICE_REVIEW = 'price_test_review';
  process.env.STRIPE_PRICE_REVIEW_OVERAGE = 'price_test_review_overage';

  const db = testAppDatabase();
  const tenant = db.createTenant('billing-auth');
  const owner = db.createPasswordUser({ email: 'owner@example.test', passwordHash: 'unused' })!;
  const member = db.createPasswordUser({ email: 'member@example.test', passwordHash: 'unused' })!;
  const outsider = db.createPasswordUser({
    email: 'outsider@example.test',
    passwordHash: 'unused',
  })!;
  db.addWorkspaceMember(tenant.id, owner.id, 'owner');
  db.addWorkspaceMember(tenant.id, member.id, 'member');
  const ownerCookie = `orvex_session=${db.createSession(owner.id).id}`;
  const memberCookie = `orvex_session=${db.createSession(member.id).id}`;
  const outsiderCookie = `orvex_session=${db.createSession(outsider.id).id}`;
  const originalFetch = globalThis.fetch;
  let stripeCalls = 0;
  globalThis.fetch = async () => {
    stripeCalls += 1;
    return Response.json({ url: 'https://checkout.stripe.test/session' });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const app = billingRoutes();
  const request = (cookie: string | undefined, ip: string) =>
    app.request('/api/workspaces/billing-auth/billing/checkout', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-real-ip': ip,
        origin: 'https://example.test',
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify({ plan: 'review' }),
    });

  assert.equal((await request(undefined, '192.0.2.60')).status, 401);
  assert.equal((await request(outsiderCookie, '192.0.2.61')).status, 403);
  assert.equal((await request(memberCookie, '192.0.2.62')).status, 403);
  assert.equal(stripeCalls, 0, 'unauthorized requests never reach Stripe');

  const checkout = await request(ownerCookie, '192.0.2.63');
  assert.equal(checkout.status, 200);
  const checkoutBody = (await checkout.json()) as { url?: string };
  assert.equal(checkoutBody.url, 'https://checkout.stripe.test/session');
  assert.equal(stripeCalls, 1);

  // Hono's Fetch test transport has no socket peer, so the spoofed X-Real-IP
  // values must not create independent checkout buckets.
  for (let i = 0; i < 11; i += 1) {
    assert.equal(
      (await request(ownerCookie, `192.0.2.${64 + i}`)).status,
      200,
      `allowed checkout ${i + 1}`,
    );
  }
  const limited = await request(ownerCookie, '198.51.100.1');
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);
});

test('marketing checkout resumes after login and requires an explicit workspace when an owner has several', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'orvex-billing-picker-'));
  const previous = snapshotEnv([
    'STORE_PATH',
    'PLATFORM_SECRET',
    'APP_URL',
    'ORVEX_REQUIRE_LOGIN',
    'STRIPE_SECRET_KEY',
    'STRIPE_PRICE_REVIEW',
    'STRIPE_PRICE_REVIEW_OVERAGE',
  ]);
  t.after(() => {
    restoreEnv(previous);
    rmSync(dir, { recursive: true, force: true });
  });
  process.env.STORE_PATH = path.join(dir, 'app.db');
  process.env.PLATFORM_SECRET = 'test-platform-secret-that-is-not-used-in-production';
  process.env.APP_URL = 'https://example.test';
  process.env.ORVEX_REQUIRE_LOGIN = '1';
  process.env.STRIPE_SECRET_KEY = 'sk_test_no_network';
  process.env.STRIPE_PRICE_REVIEW = 'price_test_review';
  process.env.STRIPE_PRICE_REVIEW_OVERAGE = 'price_test_review_overage';

  const db = testAppDatabase();
  const first = db.createTenant('first-workspace', 'First workspace');
  const second = db.createTenant('second-workspace', 'Second workspace');
  const owner = db.createPasswordUser({ email: 'picker@example.test', passwordHash: 'unused' })!;
  db.addWorkspaceMember(first.id, owner.id, 'owner');
  db.addWorkspaceMember(second.id, owner.id, 'owner');
  const cookie = `orvex_session=${db.createSession(owner.id).id}`;
  const app = billingRoutes();

  const signedOut = await app.request('/buy/review', { headers: { 'x-real-ip': '192.0.2.80' } });
  assert.equal(signedOut.status, 302);
  assert.equal(signedOut.headers.get('location'), '/auth/login?next=%2Fbuy%2Freview');

  const originalFetch = globalThis.fetch;
  let stripeCalls = 0;
  let selectedTenant: string | null = null;
  globalThis.fetch = async (_url, init) => {
    stripeCalls += 1;
    const body = new URLSearchParams(String(init?.body));
    selectedTenant = body.get('metadata[tenant_slug]');
    return Response.json({ url: 'https://checkout.stripe.test/session' });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const picker = await app.request('/buy/review', {
    headers: { cookie, 'x-real-ip': '192.0.2.81' },
  });
  assert.equal(picker.status, 200);
  assert.match(await picker.text(), /Choose a workspace/);
  assert.equal(stripeCalls, 0);

  const checkout = await app.request('/buy/review?workspace=second-workspace', {
    headers: { cookie, 'x-real-ip': '192.0.2.82' },
  });
  assert.equal(checkout.status, 302);
  assert.equal(checkout.headers.get('location'), 'https://checkout.stripe.test/session');
  assert.equal(stripeCalls, 1);
  assert.equal(selectedTenant, 'second-workspace');
});

function billingRoutes() {
  return createBillingRoutes(testRouteDependencies());
}

function isCurrentSubscription(
  db: AppDatabase,
  tenantId: string,
  subscriptionId: string | undefined,
) {
  return isCurrentSubscriptionWithConfig(db, tenantId, subscriptionId, testServerConfig());
}

function verifyStripeSignature(rawBody: string, signature: string | undefined, secret: string) {
  return verifyStripeSignatureWithConfig(rawBody, signature, secret, testServerConfig());
}

function snapshotEnv(keys: string[]): Map<string, string | undefined> {
  return new Map(keys.map((key) => [key, process.env[key]]));
}

function stripeSignature(body: string, secret: string): string {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const digest = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${digest}`;
}

function restoreEnv(snapshot: Map<string, string | undefined>): void {
  for (const [key, value] of snapshot) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
