import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AppDatabase } from '@orvex-review/store';
import { superadminRoutes } from './superadmin.js';

test('super-admin cost API returns model, tenant, margin, and run detail', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'orvex-superadmin-costs-'));
  const previousStore = process.env.STORE_PATH;
  const previousSecret = process.env.ORVEX_ADMIN_SECRET;
  t.after(() => {
    if (previousStore === undefined) delete process.env.STORE_PATH;
    else process.env.STORE_PATH = previousStore;
    if (previousSecret === undefined) delete process.env.ORVEX_ADMIN_SECRET;
    else process.env.ORVEX_ADMIN_SECRET = previousSecret;
    rmSync(dir, { recursive: true, force: true });
  });
  process.env.STORE_PATH = path.join(dir, 'app.db');
  process.env.ORVEX_ADMIN_SECRET = 'admin-test-secret';

  const db = new AppDatabase(process.env.STORE_PATH);
  const tenant = db.createTenant('profit-client', 'Profit Client');
  db.setTenantPlan(tenant.id, 'verify');
  db.setTenantBilling(tenant.id, {
    stripeCustomerId: 'cus_profit',
    stripeSubscriptionStatus: 'active',
  });
  const run = db.recordReviewRun({
    tenantId: tenant.id,
    installationId: 1,
    owner: 'profit-client',
    repo: 'api',
    pr: 12,
    headSha: 'sha12',
    action: 'opened',
    status: 'completed',
    durationMs: 2400,
  });
  db.recordReviewRunUsage({
    runId: run.id,
    tenantId: tenant.id,
    provider: 'minimax',
    model: 'MiniMax-M3',
    tier: 'standard',
    passName: 'pass 4',
    inputTokens: 10_000,
    outputTokens: 2_000,
    inputRatePerM: 0.3,
    outputRatePerM: 1.2,
    costUsd: 0.0054,
    tokenSource: 'provider',
  });
  db.recordStripeRevenueEvent({
    eventId: 'evt_profit',
    eventType: 'invoice.paid',
    invoiceId: 'in_profit',
    tenantId: tenant.id,
    customerId: 'cus_profit',
    amountCents: 9900,
    currency: 'usd',
    occurredAt: new Date().toISOString(),
  });

  const response = await superadminRoutes().request('/superadmin/api/costs?days=30', {
    headers: { Authorization: 'Bearer admin-test-secret' },
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    overview: {
      costUsd: number;
      actualRevenueUsd: number;
      actualProfitUsd: number;
      modeledNetMarginPct: number | null;
      telemetryCoveragePct: number;
    };
    byModel: Array<{ model: string; costUsd: number }>;
    byTenant: Array<{ planLabel: string; actualMarginPct: number | null }>;
    recentRuns: Array<{ usage: unknown[]; legacyCost: boolean }>;
  };
  assert.ok(Math.abs(body.overview.costUsd - 0.0054) < 1e-9);
  assert.equal(body.overview.actualRevenueUsd, 99);
  assert.ok(body.overview.actualProfitUsd > 98);
  assert.equal(body.overview.telemetryCoveragePct, 100);
  assert.equal(body.byModel[0]?.model, 'MiniMax-M3');
  assert.equal(body.byTenant[0]?.planLabel, 'Verify');
  assert.ok((body.byTenant[0]?.actualMarginPct ?? 0) > 99);
  assert.equal(body.recentRuns[0]?.legacyCost, false);
  assert.equal(body.recentRuns[0]?.usage.length, 1);

  const week = await superadminRoutes().request(
    `/superadmin/api/costs?since=${encodeURIComponent(new Date(Date.now() - 7 * 86_400_000).toISOString())}&until=${encodeURIComponent(new Date().toISOString())}`,
    { headers: { Authorization: 'Bearer admin-test-secret' } },
  );
  const weekBody = (await week.json()) as { overview: { modeledNetMarginPct: number | null } };
  assert.ok((weekBody.overview.modeledNetMarginPct ?? 0) > 90, 'window margin uses windowed modeled revenue');

  const savedCost = await superadminRoutes().request('/superadmin/api/operating-costs', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer admin-test-secret',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ category: 'monitoring', amountCents: 1234 }),
  });
  assert.equal(savedCost.status, 200);
  const afterCost = await superadminRoutes().request('/superadmin/api/costs?days=30', {
    headers: { Authorization: 'Bearer admin-test-secret' },
  });
  const afterBody = (await afterCost.json()) as { overview: { monthlyFixedCostUsd: number; actualNetProfitUsd: number } };
  assert.equal(afterBody.overview.monthlyFixedCostUsd, 12.34);
  assert.ok(afterBody.overview.actualNetProfitUsd < body.overview.actualProfitUsd);
});

test('super-admin cost API rejects unauthenticated callers', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'orvex-superadmin-auth-'));
  const previousStore = process.env.STORE_PATH;
  const previousSecret = process.env.ORVEX_ADMIN_SECRET;
  const previousReviewSecret = process.env.REVIEW_API_SECRET;
  process.env.STORE_PATH = path.join(dir, 'app.db');
  process.env.ORVEX_ADMIN_SECRET = 'admin-test-secret';
  process.env.REVIEW_API_SECRET = 'review-only-secret';
  t.after(() => {
    if (previousStore === undefined) delete process.env.STORE_PATH;
    else process.env.STORE_PATH = previousStore;
    if (previousReviewSecret === undefined) delete process.env.REVIEW_API_SECRET;
    else process.env.REVIEW_API_SECRET = previousReviewSecret;
    rmSync(dir, { recursive: true, force: true });
  });
  try {
    const response = await superadminRoutes().request('/superadmin/api/costs?days=1');
    assert.equal(response.status, 401);
    const reviewCredential = await superadminRoutes().request('/superadmin/api/costs?days=1', {
      headers: { Authorization: 'Bearer review-only-secret' },
    });
    assert.equal(reviewCredential.status, 401);
  } finally {
    if (previousSecret === undefined) delete process.env.ORVEX_ADMIN_SECRET;
    else process.env.ORVEX_ADMIN_SECRET = previousSecret;
  }
});

test('super-admin active-reviews API returns host metrics and live client rows', async (t) => {
  const previousSecret = process.env.ORVEX_ADMIN_SECRET;
  t.after(() => {
    if (previousSecret === undefined) delete process.env.ORVEX_ADMIN_SECRET;
    else process.env.ORVEX_ADMIN_SECRET = previousSecret;
  });
  process.env.ORVEX_ADMIN_SECRET = 'admin-test-secret';

  // Use the same shared AppDatabase the route factory uses (createAppDatabase
  // is a process singleton — a second STORE_PATH would not be visible to it).
  const { createAppDatabase } = await import('@orvex-review/store');
  const db = createAppDatabase();
  const slug = `live-client-${Date.now()}`;
  const tenant = db.createTenant(slug, 'Live Client');
  db.setTenantPlan(tenant.id, 'verify');

  const { runWithActiveReview } = await import('../active-reviews.js');

  const empty = await superadminRoutes().request('/superadmin/api/active-reviews', {
    headers: { Authorization: 'Bearer admin-test-secret' },
  });
  assert.equal(empty.status, 200);
  const emptyBody = (await empty.json()) as {
    host: { memory: { availableBytes: number }; worker: { activeReviews: number } };
    reviews: unknown[];
    queue: { queued: number; waitingOnPr: number; inFlight: number };
  };
  assert.ok(emptyBody.host.memory.availableBytes > 0);
  assert.equal(emptyBody.host.worker.activeReviews, 0);
  assert.deepEqual(emptyBody.reviews, []);
  assert.ok(emptyBody.queue);
  assert.equal(typeof emptyBody.queue.queued, 'number');
  assert.equal(typeof emptyBody.queue.waitingOnPr, 'number');

  await runWithActiveReview(
    {
      installationId: 99,
      tenantId: tenant.id,
      owner: slug,
      repo: 'svc',
      pr: 7,
      headSha: 'deadbeefcafebabe',
      action: 'synchronize',
      kind: 'review',
      deep: true,
      enqueuedAt: new Date().toISOString(),
    },
    async () => {
      const live = await superadminRoutes().request('/superadmin/api/active-reviews', {
        headers: { Authorization: 'Bearer admin-test-secret' },
      });
      assert.equal(live.status, 200);
      const body = (await live.json()) as {
        reviews: Array<{
          tenantId: string;
          tenantSlug: string | null;
          planLabel: string;
          pr: number;
          deep: boolean;
          totalRssBytes: number;
          kind: string;
        }>;
        host: { worker: { activeReviews: number; maxConcurrentReviews: number } };
      };
      assert.equal(body.host.worker.activeReviews, 1);
      assert.ok(body.host.worker.maxConcurrentReviews >= 1);
      assert.equal(body.reviews.length, 1);
      assert.equal(body.reviews[0]!.tenantId, tenant.id);
      assert.equal(body.reviews[0]!.tenantSlug, slug);
      assert.equal(body.reviews[0]!.pr, 7);
      assert.equal(body.reviews[0]!.deep, true);
      assert.equal(body.reviews[0]!.kind, 'review');
      assert.match(body.reviews[0]!.planLabel, /verify/i);
      assert.ok(body.reviews[0]!.totalRssBytes > 0);
    },
  );

  const unauthorized = await superadminRoutes().request('/superadmin/api/active-reviews');
  assert.equal(unauthorized.status, 401);
});

test('super-admin scoreboard returns empty placeholder instead of 404', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'orvex-superadmin-score-'));
  const previousStore = process.env.STORE_PATH;
  const previousSecret = process.env.ORVEX_ADMIN_SECRET;
  t.after(() => {
    if (previousStore === undefined) delete process.env.STORE_PATH;
    else process.env.STORE_PATH = previousStore;
    if (previousSecret === undefined) delete process.env.ORVEX_ADMIN_SECRET;
    else process.env.ORVEX_ADMIN_SECRET = previousSecret;
    rmSync(dir, { recursive: true, force: true });
  });
  process.env.STORE_PATH = path.join(dir, 'app.db');
  process.env.ORVEX_ADMIN_SECRET = 'admin-test-secret';

  const response = await superadminRoutes().request('/superadmin/api/scoreboard', {
    headers: { Authorization: 'Bearer admin-test-secret' },
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { empty?: boolean; prsAnalyzed: number };
  assert.equal(body.empty, true);
  assert.equal(body.prsAnalyzed, 0);

  const history = await superadminRoutes().request('/superadmin/api/scoreboard/history', {
    headers: { Authorization: 'Bearer admin-test-secret' },
  });
  assert.equal(history.status, 200);
  const histBody = (await history.json()) as { snapshots: unknown[] };
  assert.deepEqual(histBody.snapshots, []);
});

test('super-admin bearer rejects PLATFORM_SECRET when ORVEX_ADMIN_SECRET is unset', async (t) => {
  const previousAdmin = process.env.ORVEX_ADMIN_SECRET;
  const previousPlatform = process.env.PLATFORM_SECRET;
  t.after(() => {
    if (previousAdmin === undefined) delete process.env.ORVEX_ADMIN_SECRET;
    else process.env.ORVEX_ADMIN_SECRET = previousAdmin;
    if (previousPlatform === undefined) delete process.env.PLATFORM_SECRET;
    else process.env.PLATFORM_SECRET = previousPlatform;
  });
  delete process.env.ORVEX_ADMIN_SECRET;
  process.env.PLATFORM_SECRET = 'platform-fallback-secret';

  const response = await superadminRoutes().request('/superadmin/api/costs?days=1', {
    headers: { Authorization: 'Bearer platform-fallback-secret' },
  });
  assert.equal(response.status, 401);
});
