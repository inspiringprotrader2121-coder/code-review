import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppDatabase } from './database.js';

function db(): AppDatabase {
  return new AppDatabase(':memory:');
}

const testTenants = new WeakMap<AppDatabase, string>();
function testTenant(d: AppDatabase): string {
  let id = testTenants.get(d);
  if (!id) {
    id = d.createTenant(`cost-${Math.random()}`).id;
    testTenants.set(d, id);
  }
  return id;
}

test('completeReviewRun persists token usage + cost, and sumAccountCost aggregates it', () => {
  const d = db();
  const id = d.startReviewRun({
    tenantId: testTenant(d), installationId: 1, owner: 'acme', repo: 'api', pr: 1, headSha: 'sha1', action: 'manual',
  });
  d.completeReviewRun(id, {
    status: 'completed', durationMs: 1000, findingsNew: 2,
    inputTokens: 500_000, outputTokens: 100_000, costUsd: 0.27,
  });
  const spend = d.sumAccountCost('acme');
  assert.equal(spend.reviews, 1);
  assert.ok(Math.abs(spend.costUsd - 0.27) < 1e-9);
});

test('completeReviewRun cannot overwrite a terminal run', () => {
  const d = db();
  const id = d.startReviewRun({
    tenantId: testTenant(d),
    installationId: 1,
    owner: 'cas-user',
    repo: 'api',
    pr: 1,
    headSha: 'cas',
    action: 'manual',
  });
  d.completeReviewRun(id, { status: 'completed', durationMs: 10, findingsNew: 2 });
  d.completeReviewRun(id, { status: 'failed', durationMs: 999, error: 'late worker' });
  const row = d.listReviewRuns(testTenant(d), 1)[0]!;
  assert.equal(row.status, 'completed');
  assert.equal(row.durationMs, 10);
  assert.equal(row.findingsNew, 2);
});

test('sumAccountCost is owner-scoped (case-insensitive) and windowed', () => {
  const d = db();
  for (const owner of ['acme', 'ACME', 'other']) {
    const id = d.startReviewRun({
      tenantId: testTenant(d), installationId: 1, owner, repo: 'api', pr: 1, headSha: 's', action: 'manual',
    });
    d.completeReviewRun(id, { status: 'completed', durationMs: 1, costUsd: 0.10 });
  }
  const acme = d.sumAccountCost('acme');
  assert.equal(acme.reviews, 2, 'acme + ACME both count');
  assert.ok(Math.abs(acme.costUsd - 0.20) < 1e-9);
  assert.equal(d.sumAccountCost('other').reviews, 1);
});

test('getWorkspaceStats includes total spend for the window', () => {
  const d = db();
  const id = d.startReviewRun({
    tenantId: testTenant(d), installationId: 1, owner: 'acme', repo: 'api', pr: 1, headSha: 's', action: 'manual',
  });
  d.completeReviewRun(id, { status: 'completed', durationMs: 1, costUsd: 0.5 });
  const stats = d.getWorkspaceStats(testTenant(d));
  assert.ok(Math.abs(stats.costUsd - 0.5) < 1e-9);
});

test('persists per-model usage and builds operator profitability analytics', () => {
  const d = db();
  const tenant = d.createTenant('acme', 'Acme');
  d.setTenantPlan(tenant.id, 'verify');
  d.setTenantBilling(tenant.id, {
    stripeCustomerId: 'cus_acme',
    stripeSubscriptionStatus: 'active',
  });
  const run = d.recordReviewRun({
    tenantId: tenant.id,
    installationId: 1,
    owner: 'acme',
    repo: 'api',
    pr: 42,
    headSha: 'sha42',
    action: 'manual',
    status: 'completed',
    durationMs: 1000,
    createdAt: '2026-08-05T10:00:00.000Z',
  });
  d.recordReviewRunUsage({
    runId: run.id,
    tenantId: tenant.id,
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    tier: 'deepseek-flash',
    passName: 'verification',
    inputTokens: 1_000_000,
    outputTokens: 100_000,
    inputRatePerM: 0.14,
    outputRatePerM: 0.28,
    costUsd: 0.168,
    tokenSource: 'provider',
    attemptId: 'attempt-1',
    createdAt: '2026-08-05T10:01:00.000Z',
  });
  assert.equal(d.recordStripeRevenueEvent({
    eventId: 'evt_invoice_42',
    eventType: 'invoice.paid',
    invoiceId: 'in_42',
    tenantId: tenant.id,
    customerId: 'cus_acme',
    amountCents: 9900,
    currency: 'usd',
    occurredAt: '2026-08-05T09:00:00.000Z',
  }), true);
  assert.equal(d.recordStripeRevenueEvent({
    eventId: 'evt_invoice_42',
    eventType: 'invoice.paid',
    invoiceId: 'in_42',
    tenantId: tenant.id,
    customerId: 'cus_acme',
    amountCents: 9900,
    currency: 'usd',
    occurredAt: '2026-08-05T09:00:00.000Z',
  }), false);
  d.upsertPlatformCost({ category: 'server', amountCents: 1000, note: 'test host' });

  const analytics = d.getSuperadminCostAnalytics(
    '2026-08-01T00:00:00.000Z',
    '2026-09-01T00:00:00.000Z',
    { verify: 9900 },
  );
  assert.equal(analytics.overview.instrumentedRuns, 1);
  assert.ok(Math.abs(analytics.overview.costUsd - 0.168) < 1e-9);
  assert.ok(Math.abs(analytics.overview.actualRevenueUsd - 99) < 1e-9);
  assert.equal(analytics.byModel[0]?.model, 'deepseek-v4-flash');
  assert.equal(analytics.byTenant[0]?.plan, 'verify');
  assert.ok(Math.abs((analytics.byTenant[0]?.modeledMonthlyRevenueUsd ?? 0) - 99) < 1e-9);
  assert.equal(analytics.overview.monthlyFixedCostUsd, 10);
  assert.equal(analytics.platformCosts[0]?.category, 'server');
  assert.equal(analytics.recentRuns[0]?.usage.length, 1);
});

test('usage ledger rejects unknown runs and cross-tenant attribution', () => {
  const d = db();
  const tenant = d.createTenant('owner');
  const run = d.recordReviewRun({
    tenantId: tenant.id,
    installationId: 1,
    owner: 'owner',
    repo: 'api',
    pr: 1,
    headSha: 'sha',
    action: 'manual',
    status: 'running',
    durationMs: 0,
  });
  const input = {
    runId: run.id,
    tenantId: tenant.id,
    provider: 'test',
    model: 'test',
    tier: 'standard',
    inputTokens: 1,
    outputTokens: 1,
    inputRatePerM: 1,
    outputRatePerM: 1,
    costUsd: 0.000002,
    tokenSource: 'estimate' as const,
  };
  assert.throws(() => d.recordReviewRunUsage({ ...input, runId: 'missing' }), /unknown review run/);
  assert.throws(() => d.recordReviewRunUsage({ ...input, tenantId: 'other-tenant' }), /tenant mismatch/);
});

test('failed runs retain provider spend from the usage ledger', () => {
  const d = db();
  const tenant = d.createTenant('failed-run');
  const runId = d.startReviewRun({
    tenantId: tenant.id,
    installationId: 1,
    owner: 'failed-run',
    repo: 'api',
    pr: 7,
    headSha: 'sha7',
    action: 'manual',
  });
  d.recordReviewRunUsage({
    runId,
    tenantId: tenant.id,
    provider: 'codex-cli',
    model: 'gpt-5.6-luna',
    tier: 'openai',
    passName: 'codex pass',
    inputTokens: 500,
    outputTokens: 200,
    inputRatePerM: 0.2,
    outputRatePerM: 1.2,
    costUsd: 0.00034,
    tokenSource: 'provider',
  });
  d.completeReviewRun(runId, { status: 'failed', durationMs: 10, error: 'provider timeout' });
  const analytics = d.getSuperadminCostAnalytics(
    new Date(Date.now() - 60_000).toISOString(),
    new Date(Date.now() + 60_000).toISOString(),
  );
  assert.ok(Math.abs(analytics.overview.costUsd - 0.00034) < 1e-9);
  assert.equal(analytics.overview.failedRuns, 1);
});

test('profitability analytics does not mix non-USD revenue into USD margins', () => {
  const d = db();
  d.recordStripeRevenueEvent({
    eventId: 'evt_usd',
    eventType: 'invoice.paid',
    amountCents: 1000,
    currency: 'usd',
    occurredAt: '2026-08-05T00:00:00.000Z',
  });
  d.recordStripeRevenueEvent({
    eventId: 'evt_eur',
    eventType: 'invoice.paid',
    amountCents: 2000,
    currency: 'eur',
    occurredAt: '2026-08-05T00:00:00.000Z',
  });
  const analytics = d.getSuperadminCostAnalytics(
    '2026-08-01T00:00:00.000Z',
    '2026-09-01T00:00:00.000Z',
  );
  assert.equal(analytics.overview.actualRevenueUsd, 10);
  assert.deepEqual(analytics.overview.nonUsdRevenue, [{ currency: 'eur', amountCents: 2000 }]);
  assert.equal(analytics.daily.find((row) => row.day === '2026-08-05')?.actualRevenueUsd, 10);
});

test('revenue ledger accepts multiple partial refunds for one charge', () => {
  const d = db();
  assert.equal(
    d.recordStripeRevenueEvent({
      eventId: 'refund_1',
      eventType: 'charge.refunded',
      invoiceId: 'ch_partial',
      amountCents: -300,
      currency: 'usd',
      occurredAt: '2026-08-05T00:00:00.000Z',
    }),
    true,
  );
  assert.equal(
    d.recordStripeRevenueEvent({
      eventId: 'refund_2',
      eventType: 'charge.refunded',
      invoiceId: 'ch_partial',
      amountCents: -200,
      currency: 'usd',
      occurredAt: '2026-08-06T00:00:00.000Z',
    }),
    true,
  );
  assert.equal(d.sumStripeRefundsForCharge('ch_partial'), 500);
});

test('unlinked Stripe revenue is assigned when checkout later links the customer', () => {
  const d = db();
  assert.equal(
    d.recordStripeRevenueEvent({
      eventId: 'invoice_pending',
      eventType: 'invoice.paid',
      invoiceId: 'in_pending',
      customerId: 'cus_pending',
      amountCents: 2900,
      currency: 'usd',
      occurredAt: '2026-08-05T00:00:00.000Z',
    }),
    true,
  );
  assert.equal(d.assignUnlinkedStripeRevenue('cus_pending', 't1'), 1);
  const analytics = d.getSuperadminCostAnalytics(
    '2026-08-01T00:00:00.000Z',
    '2026-08-06T00:00:00.000Z',
    {},
  );
  assert.equal(analytics.overview.actualRevenueUsd, 29);
});
