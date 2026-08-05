import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AppDatabase, createAppDatabase } from '@orvex-review/store';
import { billingRoutes, reportStripeReviewOverage, isCurrentSubscription, verifyStripeSignature } from './billing.js';

test('verifies Stripe webhook signatures', () => {
  const body = JSON.stringify({ id: 'evt_test', type: 'checkout.session.completed' });
  const secret = 'whsec_test';
  // current timestamp — the tolerance check rejects stale signatures (replay guard)
  const timestamp = String(Math.floor(Date.now() / 1000));
  const digest = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');

  assert.equal(verifyStripeSignature(body, `t=${timestamp},v1=${digest}`, secret), true);
  assert.equal(verifyStripeSignature(body, `t=${timestamp},v1=bad`, secret), false);
  assert.equal(verifyStripeSignature(`${body}\n`, `t=${timestamp},v1=${digest}`, secret), false);
  // a stale (validly-signed) timestamp is rejected — no replay
  const old = String(Math.floor(Date.now() / 1000) - 10_000);
  const oldDigest = createHmac('sha256', secret).update(`${old}.${body}`).digest('hex');
  assert.equal(verifyStripeSignature(body, `t=${old},v1=${oldDigest}`, secret), false);
});

test('reports only completed reviews above the included quota as Stripe overage', async (t) => {
  const db = new AppDatabase(':memory:');
  const tenant = db.createTenant('acme', 'Acme');
  db.setTenantBilling(tenant.id, {
    stripeCustomerId: 'cus_test',
    stripeCurrentPeriodStart: '2026-07-01T00:00:00.000Z',
  });
  // Seed exactly the included quota (Starter = 100); the next completed review
  // is the first overage.
  for (let i = 0; i < 100; i += 1) {
    db.recordReviewRun({
      tenantId: tenant.id,
      installationId: 1,
      owner: 'acme',
      repo: 'api',
      pr: i + 1,
      headSha: `sha${i}`,
      action: 'synchronize',
      status: 'completed',
      durationMs: 1000,
      createdAt: '2026-07-02T00:00:00.000Z',
    });
  }

  const originalFetch = globalThis.fetch;
  const originalSecret = process.env.STRIPE_SECRET_KEY;
  process.env.STRIPE_SECRET_KEY = 'sk_test';
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls += 1;
    const body = new URLSearchParams(String(init?.body));
    assert.equal(body.get('event_name'), 'orvex_review_overage');
    assert.equal(body.get('payload[stripe_customer_id]'), 'cus_test');
    assert.equal(body.get('payload[value]'), '1');
    return Response.json({ object: 'billing.meter_event' });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalSecret === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = originalSecret;
  });

  assert.equal(
    await reportStripeReviewOverage({ store: db, tenantId: tenant.id, plan: 'review', runId: 'included' }),
    'included',
  );

  db.recordReviewRun({
    tenantId: tenant.id,
    installationId: 1,
    owner: 'acme',
    repo: 'api',
    pr: 100,
    headSha: 'sha100',
    action: 'synchronize',
    status: 'completed',
    durationMs: 1000,
    createdAt: '2026-07-03T00:00:00.000Z',
  });
  assert.equal(
    await reportStripeReviewOverage({ store: db, tenantId: tenant.id, plan: 'review', runId: 'overage' }),
    'reported',
  );
  assert.equal(calls, 1);
});

test('a deep review bills as 2 units — and only the units above the included line', async (t) => {
  const db = new AppDatabase(':memory:');
  const tenant = db.createTenant('acme', 'Acme');
  db.setTenantBilling(tenant.id, {
    stripeCustomerId: 'cus_test',
    stripeCurrentPeriodStart: '2026-07-01T00:00:00.000Z',
  });
  // Verify Lite includes 50 units. Seed 49 normal reviews → 49 units used, 1 left.
  for (let i = 0; i < 49; i += 1) {
    db.recordReviewRun({
      tenantId: tenant.id, installationId: 1, owner: 'acme', repo: 'api', pr: i + 1,
      headSha: `sha${i}`, action: 'command', status: 'completed', durationMs: 1000,
      createdAt: '2026-07-02T00:00:00.000Z',
    });
  }

  process.env.STRIPE_SECRET_KEY = 'sk_test';
  process.env.STRIPE_METER_EVENT_VERIFY_LITE = 'orvex_verify_lite_overage';
  let reportedValue: string | null = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = new URLSearchParams(String(init?.body));
    reportedValue = body.get('payload[value]');
    assert.equal(body.get('event_name'), 'orvex_verify_lite_overage');
    return Response.json({ object: 'billing.meter_event' });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_METER_EVENT_VERIFY_LITE;
  });

  // A DEEP review now runs: 49 + 2 = 51 units, included is 50 → exactly 1 unit
  // lands above the line (unit 50 was included, unit 51 is the only overage).
  db.recordReviewRun({
    tenantId: tenant.id, installationId: 1, owner: 'acme', repo: 'api', pr: 500,
    headSha: 'shaDeep', action: 'command', status: 'completed', durationMs: 1000,
    deep: true, createdAt: '2026-07-03T00:00:00.000Z',
  });
  const result = await reportStripeReviewOverage({
    store: db, tenantId: tenant.id, plan: 'verify-lite', runId: 'deep1', deep: true,
  });
  assert.equal(result, 'reported');
  assert.equal(reportedValue, '1', 'deep review straddling the quota line bills only the 1 unit over it');
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

  const db = createAppDatabase();
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
  globalThis.fetch = async () => {
    cancelCalls += 1;
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
  assert.equal(cancelCalls, 1);

  const duplicate = await request();
  assert.equal(duplicate.status, 200);
  assert.deepEqual(await duplicate.json(), { received: true, deduped: true });
  assert.equal(cancelCalls, 1, 'durable dedupe prevents a second subscription cancellation');
});

test('quota exhaustion meters each metered plan but never the unlimited plan', async (t) => {
  const db = new AppDatabase(':memory:');
  const originalFetch = globalThis.fetch;
  const originalSecret = process.env.STRIPE_SECRET_KEY;
  process.env.STRIPE_SECRET_KEY = 'sk_test_no_network';
  const events: Array<{ name: string | null; value: string | null; idempotency: string | null }> = [];
  globalThis.fetch = async (_url, init) => {
    const body = new URLSearchParams(String(init?.body));
    events.push({
      name: body.get('event_name'),
      value: body.get('payload[value]'),
      idempotency: new Headers(init?.headers).get('Idempotency-Key'),
    });
    return Response.json({ object: 'billing.meter_event' });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalSecret === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = originalSecret;
  });

  const metered = [
    { plan: 'review' as const, included: 100, event: 'orvex_review_overage' },
    { plan: 'verify-lite' as const, included: 50, event: 'orvex_verify_lite_overage' },
    { plan: 'verify' as const, included: 120, event: 'orvex_verify_overage' },
  ];
  for (const item of metered) {
    const tenant = db.createTenant(`quota-${item.plan}`);
    db.setTenantBilling(tenant.id, {
      stripeCustomerId: `cus_${item.plan}`,
      stripeCurrentPeriodStart: '2026-07-01T00:00:00.000Z',
    });
    for (let i = 0; i < item.included; i += 1) {
      recordReview(db, tenant.id, i, 'completed');
    }
    recordReview(db, tenant.id, item.included + 10_000, 'failed');
    assert.equal(
      await reportStripeReviewOverage({ store: db, tenantId: tenant.id, plan: item.plan, runId: `${item.plan}-included` }),
      'included',
    );

    recordReview(db, tenant.id, item.included, 'completed');
    assert.equal(
      await reportStripeReviewOverage({ store: db, tenantId: tenant.id, plan: item.plan, runId: `${item.plan}-overage` }),
      'reported',
    );
  }

  const unlimited = db.createTenant('quota-review-plus');
  db.setTenantBilling(unlimited.id, { stripeCustomerId: 'cus_review_plus' });
  recordReview(db, unlimited.id, 1, 'completed');
  assert.equal(
    await reportStripeReviewOverage({ store: db, tenantId: unlimited.id, plan: 'review-plus', runId: 'unlimited' }),
    'included',
  );
  assert.deepEqual(events, metered.map((item) => ({
    name: item.event,
    value: '1',
    idempotency: `review_run_${item.plan}-overage`,
  })));
});

test('billing checkout is owner-only and throttled without contacting Stripe', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'orvex-billing-auth-'));
  const previous = snapshotEnv([
    'STORE_PATH', 'PLATFORM_SECRET', 'APP_URL', 'ORVEX_REQUIRE_LOGIN', 'STRIPE_SECRET_KEY',
    'STRIPE_PRICE_REVIEW', 'STRIPE_PRICE_REVIEW_OVERAGE',
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

  const db = createAppDatabase();
  const tenant = db.createTenant('billing-auth');
  const owner = db.createPasswordUser({ email: 'owner@example.test', passwordHash: 'unused' })!;
  const member = db.createPasswordUser({ email: 'member@example.test', passwordHash: 'unused' })!;
  const outsider = db.createPasswordUser({ email: 'outsider@example.test', passwordHash: 'unused' })!;
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
  t.after(() => { globalThis.fetch = originalFetch; });
  const app = billingRoutes();
  const request = (cookie: string | undefined, ip: string) => app.request('/api/workspaces/billing-auth/billing/checkout', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-real-ip': ip,
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
  const checkoutBody = await checkout.json() as { url?: string };
  assert.equal(checkoutBody.url, 'https://checkout.stripe.test/session');
  assert.equal(stripeCalls, 1);

  for (let i = 0; i < 12; i += 1) {
    assert.equal((await request(ownerCookie, '192.0.2.64')).status, 200, `allowed checkout ${i + 1}`);
  }
  const limited = await request(ownerCookie, '192.0.2.64');
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);
});

test('marketing checkout resumes after login and requires an explicit workspace when an owner has several', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'orvex-billing-picker-'));
  const previous = snapshotEnv([
    'STORE_PATH', 'PLATFORM_SECRET', 'APP_URL', 'ORVEX_REQUIRE_LOGIN', 'STRIPE_SECRET_KEY',
    'STRIPE_PRICE_REVIEW', 'STRIPE_PRICE_REVIEW_OVERAGE',
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

  const db = createAppDatabase();
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
  t.after(() => { globalThis.fetch = originalFetch; });

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

function recordReview(db: AppDatabase, tenantId: string, n: number, status: 'completed' | 'failed'): void {
  db.recordReviewRun({
    tenantId,
    installationId: 1,
    owner: tenantId,
    repo: 'api',
    pr: n + 1,
    headSha: `sha-${n}`,
    action: 'synchronize',
    status,
    durationMs: 1000,
    createdAt: '2026-07-02T00:00:00.000Z',
  });
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
