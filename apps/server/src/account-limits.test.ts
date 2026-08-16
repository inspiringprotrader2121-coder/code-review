import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppDatabase } from '@orvex-review/store';
import { planFeatures } from '@orvex-review/tenants';
import { accountLimitReason } from './pipeline.js';
import { createAccountLimitPolicy } from './review/account-limits.js';

function db(): AppDatabase {
  const d = new AppDatabase(':memory:');
  defaultTenants.set(d, d.createTenant(`limits-${Math.random()}`).id);
  return d;
}

const defaultTenants = new WeakMap<AppDatabase, string>();
const defaultTenant = (d: AppDatabase): string => defaultTenants.get(d)!;

function complete(d: AppDatabase, owner: string, n: number, tenantId = defaultTenant(d)): void {
  for (let i = 0; i < n; i++) {
    d.recordReviewRun({
      tenantId,
      installationId: 1,
      owner,
      repo: 'r',
      pr: 1,
      headSha: `sha${i}`,
      action: 'synchronize',
      status: 'completed',
      durationMs: 1000,
    });
  }
}

/** Rows spread across ~2h–28d ago (outside the 1h rate-limit window,
 *  but inside the 30-day monthly window) — isolates the monthly check from the
 *  hourly one, since a same-instant burst would always trip hourly first given
 *  reviewsPerHour << reviewsPerMonth by design. */
function completeSpreadOverDays(
  d: AppDatabase,
  owner: string,
  n: number,
  tenantId = defaultTenant(d),
): void {
  const now = Date.now();
  const span = 28 * 24 * 3_600_000;
  for (let i = 0; i < n; i++) {
    const offset = 2 * 3_600_000 + (n <= 1 ? 0 : (i * span) / (n - 1));
    d.recordReviewRun({
      tenantId,
      installationId: 1,
      owner,
      repo: 'r',
      pr: 1,
      headSha: `sha${i}`,
      action: 'synchronize',
      status: 'completed',
      durationMs: 1000,
      createdAt: new Date(now - offset).toISOString(),
    });
  }
}

test('Review monthly included quota requires prepaid credits for overage', () => {
  const d = db();
  const plan = planFeatures('review');
  const tenant = d.createTenant('prepaid-acme');
  completeSpreadOverDays(d, 'acme', plan.includedReviewsPerMonth!, tenant.id);
  assert.equal(
    accountLimitReason(d, 'acme', plan, 1, 0, { tenantId: tenant.id }),
    'insufficient_credits',
  );
  d.creditPrepaidTopUp({
    tenantId: tenant.id,
    amountCents: 500,
    stripeSessionId: 'cs_test_prepaid_1',
  });
  assert.equal(accountLimitReason(d, 'acme', plan, 1, 0, { tenantId: tenant.id }), null);
});

test('paid included quota starts at the stored Stripe billing-period boundary', () => {
  const d = db();
  const tenant = d.createTenant('stripe-period');
  const plan = planFeatures('review');
  const periodStart = new Date(Date.now() - 24 * 3_600_000).toISOString();
  d.setTenantBilling(tenant.id, {
    stripeSubscriptionStatus: 'active',
    stripeCurrentPeriodStart: periodStart,
  });
  for (let i = 0; i < plan.includedReviewsPerMonth!; i += 1) {
    d.recordReviewRun({
      tenantId: tenant.id,
      installationId: 1,
      owner: `previous-period-${i}`,
      repo: 'r',
      pr: i,
      headSha: `previous-${i}`,
      action: 'synchronize',
      status: 'completed',
      durationMs: 1,
      createdAt: new Date(Date.now() - 10 * 24 * 3_600_000).toISOString(),
    });
  }
  assert.equal(accountLimitReason(d, 'acme', plan, 1, 0, { tenantId: tenant.id }), null);

  for (let i = 0; i < plan.includedReviewsPerMonth!; i += 1) {
    d.recordReviewRun({
      tenantId: tenant.id,
      installationId: 1,
      owner: `current-period-${i}`,
      repo: 'r',
      pr: i,
      headSha: `current-${i}`,
      action: 'synchronize',
      status: 'completed',
      durationMs: 1,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
    });
  }
  assert.equal(
    accountLimitReason(d, 'acme', plan, 1, 0, { tenantId: tenant.id }),
    'insufficient_credits',
  );
});

test('Review hard safety ceiling still stops even with prepaid balance', () => {
  const d = db();
  const plan = planFeatures('review');
  const tenant = d.createTenant('prepaid-cap');
  d.creditPrepaidTopUp({
    tenantId: tenant.id,
    amountCents: 50_000,
    stripeSessionId: 'cs_test_prepaid_cap',
  });
  completeSpreadOverDays(d, 'acme', plan.reviewsPerMonth!, tenant.id);
  assert.equal(accountLimitReason(d, 'acme', plan, 1, 0, { tenantId: tenant.id }), 'monthly_limit');
});

test('the hourly ceiling is checked FIRST — when a burst crosses BOTH thresholds at once, it reports rate_limited, not monthly_limit', () => {
  const d = db();
  const plan = planFeatures('review');
  // All timestamped "now", so this single burst crosses reviewsPerMonth too —
  // confirms the more specific/actionable diagnosis (an hour-scale burst) wins.
  complete(d, 'acme', plan.reviewsPerMonth! + 1);
  assert.equal(accountLimitReason(d, 'acme', plan), 'rate_limited');
});

test('free trial exhausted wins over hourly when lifetime reviews are spent', () => {
  const d = db();
  const plan = planFeatures('free');
  assert.ok(plan.trialReviewLimit !== null);
  assert.ok(plan.reviewsPerHour !== null);
  // Lifetime spent AND current hour full — should upgrade-nudge, not "wait ~Xh".
  complete(d, 'acme', plan.trialReviewLimit!);
  assert.equal(accountLimitReason(d, 'acme', plan), 'trial_exhausted');
});

test('free tier has no separate monthly ceiling — the lifetime trial cap already bounds it', () => {
  const plan = planFeatures('free');
  assert.equal(plan.reviewsPerMonth, null);
});

test('enterprise uses high safety ceilings, not uncapped nulls', () => {
  const d = db();
  const plan = planFeatures('enterprise');
  assert.equal(plan.reviewsPerMonth, 2000);
  assert.equal(plan.reviewsPerHour, 50);
  completeSpreadOverDays(d, 'acme', plan.reviewsPerMonth!);
  assert.equal(accountLimitReason(d, 'acme', plan), 'monthly_limit');
});

test('Verify monthly included quota requires prepaid credits; hard ceiling still applies', () => {
  const d = db();
  const plan = planFeatures('verify');
  const tenant = d.createTenant('verify-prepaid');
  completeSpreadOverDays(d, 'acme', plan.includedReviewsPerMonth!, tenant.id);
  assert.equal(
    accountLimitReason(d, 'acme', plan, 1, 0, { tenantId: tenant.id }),
    'insufficient_credits',
  );
  // Paid included/prepaid is tenant-scoped — another GitHub owner on the same
  // workspace still shares the wallet/quota.
  assert.equal(
    accountLimitReason(d, 'other-co', plan, 1, 0, { tenantId: tenant.id }),
    'insufficient_credits',
  );
});

test('Pro has a hard monthly total (500) — not unlimited', () => {
  const d = db();
  const plan = planFeatures('review-plus');
  assert.equal(plan.reviewsPerMonth, 500);
  completeSpreadOverDays(d, 'pro-co', plan.reviewsPerMonth!);
  assert.equal(accountLimitReason(d, 'pro-co', plan), 'monthly_limit');
});

test('GLOBAL free-tier daily cap trips for a trial account once total free reviews cross the ceiling (abuse backstop)', () => {
  const d = db();
  const free = planFeatures('free');
  // Simulate a farm: many distinct free-tier accounts, each a fresh trial (so
  // per-account and per-IP checks never fire), together exceeding the global cap.
  const cap = Number(process.env.ORVEX_FREE_TIER_DAILY_CAP ?? 300);
  for (let i = 0; i < cap; i++) {
    d.recordReviewRun({
      tenantId: d.createTenant(`farm-${i}`).id,
      installationId: i,
      owner: `farm-acct-${i}`,
      repo: 'r',
      pr: 1,
      headSha: `s${i}`,
      action: 'opened',
      status: 'completed',
      durationMs: 100,
      freeTier: true,
    });
  }
  // a brand-new farmed account (0 of its own reviews) is now blocked by the GLOBAL cap
  assert.equal(accountLimitReason(d, 'farm-acct-new', free), 'free_tier_capped');
});

test('the global free-tier cap does NOT block PAID accounts (only trial plans are gated)', () => {
  const d = db();
  const cap = Number(process.env.ORVEX_FREE_TIER_DAILY_CAP ?? 300);
  for (let i = 0; i < cap; i++) {
    d.recordReviewRun({
      tenantId: d.createTenant(`farm-${i}`).id,
      installationId: i,
      owner: `farm-acct-${i}`,
      repo: 'r',
      pr: 1,
      headSha: `s${i}`,
      action: 'opened',
      status: 'completed',
      durationMs: 100,
      freeTier: true,
    });
  }
  // a paying tenant is unaffected by the free-tier abuse pause
  assert.equal(accountLimitReason(d, 'paying-co', planFeatures('verify')), null);
});

test('the rolling provider-cost safety ceiling blocks flat-plan spend', () => {
  const d = db();
  const cap = Number(process.env.ORVEX_MONTHLY_COGS_CAP_USD ?? 250);
  const tenantId = defaultTenant(d);
  const runId = d.startReviewRun({
    tenantId,
    installationId: 1,
    owner: 'pro-user',
    repo: 'r',
    pr: 1,
    headSha: 'expensive',
    action: 'synchronize',
  });
  d.recordReviewRunUsage({
    runId,
    tenantId,
    provider: 'test',
    model: 'test',
    tier: 'standard',
    inputTokens: 0,
    outputTokens: 0,
    inputRatePerM: 0,
    outputRatePerM: 0,
    costUsd: cap,
    tokenSource: 'estimate',
  });
  assert.equal(accountLimitReason(d, 'pro-user', planFeatures('review-plus')), 'cost_capped');
});

test('COGS safety reservations include running and newly requested reviews', () => {
  const d = db();
  const cap = Number(process.env.ORVEX_MONTHLY_COGS_CAP_USD ?? 250);
  const tenantId = defaultTenant(d);
  const completed = d.startReviewRun({
    tenantId,
    installationId: 1,
    owner: 'concurrent-user',
    repo: 'r',
    pr: 1,
    headSha: 'completed',
    action: 'synchronize',
  });
  d.completeReviewRun(completed, {
    status: 'completed',
    durationMs: 1,
    costUsd: Math.max(0, cap - 10),
  });
  d.startReviewRun({
    tenantId,
    installationId: 1,
    owner: 'concurrent-user',
    repo: 'r',
    pr: 2,
    headSha: 'running',
    action: 'synchronize',
  });
  assert.equal(
    accountLimitReason(d, 'concurrent-user', planFeatures('review-plus')),
    'cost_capped',
  );
});

test('unlimited hourly plans still enforce the COGS gate in the atomic reservation path', () => {
  const d = db();
  const plan = planFeatures('review-plus');
  const cap = Number(process.env.ORVEX_MONTHLY_COGS_CAP_USD ?? 250);
  const tenantId = defaultTenant(d);
  const prior = d.startReviewRun({
    tenantId,
    installationId: 1,
    owner: 'flat-plan-user',
    repo: 'r',
    pr: 1,
    headSha: 'prior',
    action: 'synchronize',
  });
  d.completeReviewRun(prior, { status: 'completed', durationMs: 1, costUsd: cap });
  const reserved = d.tryReserveReviewRun(
    {
      tenantId,
      installationId: 1,
      owner: 'flat-plan-user',
      repo: 'r',
      pr: 2,
      headSha: 'next',
      action: 'synchronize',
    },
    () => accountLimitReason(d, 'flat-plan-user', plan, 1),
  );
  assert.deepEqual(reserved, { ok: false, reason: 'cost_capped' });
});

test('resuming a run does not reserve a second full slot for its own recorded spend', () => {
  const d = db();
  const plan = planFeatures('review-plus');
  const cap = Number(process.env.ORVEX_MONTHLY_COGS_CAP_USD ?? 250);
  const tenantId = defaultTenant(d);
  const runId = d.startReviewRun({
    tenantId,
    installationId: 1,
    owner: 'resume-user',
    repo: 'r',
    pr: 1,
    headSha: 'resume',
    action: 'synchronize',
  });
  d.recordReviewRunUsage({
    runId,
    tenantId,
    provider: 'test',
    model: 'test',
    tier: 'standard',
    inputTokens: 0,
    outputTokens: 0,
    inputRatePerM: 0,
    outputRatePerM: 0,
    costUsd: Math.max(0, cap - 3),
    tokenSource: 'estimate',
  });
  assert.equal(accountLimitReason(d, 'resume-user', plan, 0), 'cost_capped');
  assert.equal(accountLimitReason(d, 'resume-user', plan, 0, 1), null);
});

test('per-account concurrency caps parallel burn of the hourly bucket', () => {
  const d = db();
  const plan = planFeatures('verify');
  const tenantId = defaultTenant(d);
  assert.equal(plan.maxConcurrentReviews, 5);
  for (let i = 0; i < 5; i++) {
    d.startReviewRun({
      tenantId,
      installationId: 1,
      owner: 'busy',
      repo: 'r',
      pr: i + 1,
      headSha: `run${i}`,
      action: 'opened',
    });
  }
  assert.equal(accountLimitReason(d, 'busy', plan, 1), 'concurrency_limited');
  assert.equal(
    accountLimitReason(d, 'busy', plan, 0, 0),
    null,
    'no new reservation is still under the in-flight cap',
  );
  assert.equal(
    accountLimitReason(d, 'busy', plan, 0, 1),
    null,
    'resuming one of the running rows does not trip concurrency',
  );
});

test('operator-unlimited github owners skip every account quota including COGS', () => {
  const previous = process.env.ORVEX_UNLIMITED_GITHUB_OWNERS;
  process.env.ORVEX_UNLIMITED_GITHUB_OWNERS = 'inspiringprotrader2121-coder';
  const d = db();
  const tenantId = defaultTenant(d);
  const plan = planFeatures('enterprise');
  for (let i = 0; i < 20; i++) {
    d.startReviewRun({
      tenantId,
      installationId: 1,
      owner: 'inspiringprotrader2121-coder',
      repo: 'Velatrix-Cloud',
      pr: 300 + i,
      headSha: `unlimited${i}`,
      action: 'opened',
    });
  }
  try {
    assert.equal(
      accountLimitReason(d, 'inspiringprotrader2121-coder', plan, 1, 0, { tenantId }),
      null,
    );
  } finally {
    if (previous === undefined) delete process.env.ORVEX_UNLIMITED_GITHUB_OWNERS;
    else process.env.ORVEX_UNLIMITED_GITHUB_OWNERS = previous;
  }
});

test('COGS admission uses the injected monthly cap, not the legacy plan-id default', () => {
  const d = db();
  const tenantId = defaultTenant(d);
  const highCap = createAccountLimitPolicy({
    monthlyCogsCapUsd: 5_000,
    cogsReservationUsd: 5,
  });
  const lowCap = createAccountLimitPolicy({
    monthlyCogsCapUsd: 250,
    cogsReservationUsd: 5,
  });
  const prior = d.startReviewRun({
    tenantId,
    installationId: 1,
    owner: 'burst-owner',
    repo: 'r',
    pr: 1,
    headSha: 'prior-spend',
    action: 'opened',
  });
  d.completeReviewRun(prior, { status: 'completed', durationMs: 1, costUsd: 250 });
  assert.equal(
    accountLimitReason(
      d,
      'burst-owner',
      planFeatures('enterprise'),
      1,
      0,
      { cogsOnly: true },
      lowCap,
    ),
    'cost_capped',
    'legacy $250 ceiling still blocks after $250 spend',
  );
  assert.equal(
    accountLimitReason(
      d,
      'burst-owner',
      planFeatures('enterprise'),
      1,
      0,
      { cogsOnly: true },
      highCap,
    ),
    null,
    'operator ORVEX_MONTHLY_COGS_CAP_USD must allow scale bursts past the legacy default',
  );

  // Reservation projection alone: 49 running × $5 + 1 pending = $250 under low cap.
  const scaleTenant = defaultTenant(d);
  for (let i = 0; i < 49; i++) {
    d.startReviewRun({
      tenantId: scaleTenant,
      installationId: 1,
      owner: 'scale-owner',
      repo: 'r',
      pr: i + 10,
      headSha: `scale${i}`,
      action: 'opened',
    });
  }
  const unlimitedConcurrency = {
    ...planFeatures('enterprise'),
    maxConcurrentReviews: null,
  };
  assert.equal(
    accountLimitReason(d, 'scale-owner', unlimitedConcurrency, 1, 0, { cogsOnly: true }, lowCap),
    'cost_capped',
  );
  assert.equal(
    accountLimitReason(d, 'scale-owner', unlimitedConcurrency, 1, 0, { cogsOnly: true }, highCap),
    null,
  );
  // 999 running × $5 would exceed the production $5000 ceiling.
  for (let i = 49; i < 999; i++) {
    d.startReviewRun({
      tenantId: scaleTenant,
      installationId: 1,
      owner: 'scale-owner',
      repo: 'r',
      pr: i + 10,
      headSha: `scale${i}`,
      action: 'opened',
    });
  }
  assert.equal(
    accountLimitReason(d, 'scale-owner', unlimitedConcurrency, 1, 0, { cogsOnly: true }, highCap),
    'cost_capped',
  );
});
