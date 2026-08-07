import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppDatabase } from '@orvex-review/store';
import { planFeatures } from '@orvex-review/tenants';
import { accountLimitReason } from './pipeline.js';

function db(): AppDatabase {
  return new AppDatabase(':memory:');
}

function complete(d: AppDatabase, owner: string, n: number): void {
  for (let i = 0; i < n; i++) {
    d.recordReviewRun({
      tenantId: 't1', installationId: 1, owner, repo: 'r', pr: 1, headSha: `sha${i}`,
      action: 'synchronize', status: 'completed', durationMs: 1000,
    });
  }
}

/** Rows spread across the last ~29 days (well outside the 1h rate-limit window,
 *  but inside the 30-day monthly window) — isolates the monthly check from the
 *  hourly one, since a same-instant burst would always trip hourly first given
 *  reviewsPerHour << reviewsPerMonth by design. */
function completeSpreadOverDays(d: AppDatabase, owner: string, n: number): void {
  const now = Date.now();
  for (let i = 0; i < n; i++) {
    d.recordReviewRun({
      tenantId: 't1', installationId: 1, owner, repo: 'r', pr: 1, headSha: `sha${i}`,
      action: 'synchronize', status: 'completed', durationMs: 1000,
      createdAt: new Date(now - 3 * 3_600_000 - i * 3_600_000).toISOString(), // 3h+ ago, spaced 1h apart
    });
  }
}

test('Review monthly quota is included usage, not a hard stop', () => {
  const d = db();
  const plan = planFeatures('review');
  assert.ok(plan.reviewsPerMonth !== null);
  assert.equal(plan.overageCentsPerReview, 50);
  completeSpreadOverDays(d, 'acme', plan.reviewsPerMonth! + 10);
  assert.equal(accountLimitReason(d, 'acme', plan), null, 'over quota is billed as overage');
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

test('enterprise (custom contract) is never limited by these code defaults', () => {
  const d = db();
  const plan = planFeatures('enterprise');
  complete(d, 'acme', 10_000);
  assert.equal(accountLimitReason(d, 'acme', plan), null);
});

test('Verify monthly quota is included usage, not a hard stop', () => {
  const d = db();
  const plan = planFeatures('verify');
  assert.equal(plan.overageCentsPerReview, 75);
  completeSpreadOverDays(d, 'acme', plan.reviewsPerMonth! + 10);
  assert.equal(accountLimitReason(d, 'acme', plan), null, 'over quota is billed as overage');
  assert.equal(accountLimitReason(d, 'other-co', plan), null, 'a fresh account is unaffected');
});

test('GLOBAL free-tier daily cap trips for a trial account once total free reviews cross the ceiling (abuse backstop)', () => {
  const d = db();
  const free = planFeatures('free');
  // Simulate a farm: many distinct free-tier accounts, each a fresh trial (so
  // per-account and per-IP checks never fire), together exceeding the global cap.
  const cap = Number(process.env.ORVEX_FREE_TIER_DAILY_CAP ?? 300);
  for (let i = 0; i < cap; i++) {
    d.recordReviewRun({
      tenantId: `farm${i}`, installationId: i, owner: `farm-acct-${i}`, repo: 'r', pr: 1,
      headSha: `s${i}`, action: 'opened', status: 'completed', durationMs: 100, freeTier: true,
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
      tenantId: `farm${i}`, installationId: i, owner: `farm-acct-${i}`, repo: 'r', pr: 1,
      headSha: `s${i}`, action: 'opened', status: 'completed', durationMs: 100, freeTier: true,
    });
  }
  // a paying tenant is unaffected by the free-tier abuse pause
  assert.equal(accountLimitReason(d, 'paying-co', planFeatures('verify')), null);
});

test('the rolling provider-cost safety ceiling blocks flat-plan spend', () => {
  const d = db();
  const cap = Number(process.env.ORVEX_MONTHLY_COGS_CAP_USD ?? 250);
  const runId = d.startReviewRun({
    tenantId: 't1',
    installationId: 1,
    owner: 'pro-user',
    repo: 'r',
    pr: 1,
    headSha: 'expensive',
    action: 'synchronize',
  });
  d.recordReviewRunUsage({
    runId,
    tenantId: 't1',
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
  const completed = d.startReviewRun({
    tenantId: 't1',
    installationId: 1,
    owner: 'concurrent-user',
    repo: 'r',
    pr: 1,
    headSha: 'completed',
    action: 'synchronize',
  });
  d.completeReviewRun(completed, { status: 'completed', durationMs: 1, costUsd: Math.max(0, cap - 10) });
  d.startReviewRun({
    tenantId: 't1',
    installationId: 1,
    owner: 'concurrent-user',
    repo: 'r',
    pr: 2,
    headSha: 'running',
    action: 'synchronize',
  });
  assert.equal(accountLimitReason(d, 'concurrent-user', planFeatures('review-plus')), 'cost_capped');
});

test('unlimited hourly plans still enforce the COGS gate in the atomic reservation path', () => {
  const d = db();
  const plan = planFeatures('review-plus');
  const cap = Number(process.env.ORVEX_MONTHLY_COGS_CAP_USD ?? 250);
  const prior = d.startReviewRun({
    tenantId: 't1',
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
      tenantId: 't1',
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
  const runId = d.startReviewRun({
    tenantId: 't1',
    installationId: 1,
    owner: 'resume-user',
    repo: 'r',
    pr: 1,
    headSha: 'resume',
    action: 'synchronize',
  });
  d.recordReviewRunUsage({
    runId,
    tenantId: 't1',
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
