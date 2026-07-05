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

test('monthly ceiling trips once an account reaches reviewsPerMonth for a paid tier (isolated from the hourly check via backdated rows)', () => {
  const d = db();
  const plan = planFeatures('review');
  assert.ok(plan.reviewsPerMonth !== null);
  completeSpreadOverDays(d, 'acme', plan.reviewsPerMonth! - 1);
  assert.equal(accountLimitReason(d, 'acme', plan), null, 'one under the cap: not yet limited');
  completeSpreadOverDays(d, 'acme', 1);
  assert.equal(accountLimitReason(d, 'acme', plan), 'monthly_limit', 'at the cap: limited');
});

test('the hourly ceiling is checked FIRST — when a burst crosses BOTH thresholds at once, it reports rate_limited, not monthly_limit', () => {
  const d = db();
  const plan = planFeatures('review');
  // All timestamped "now", so this single burst crosses reviewsPerMonth too —
  // confirms the more specific/actionable diagnosis (an hour-scale burst) wins.
  complete(d, 'acme', plan.reviewsPerMonth! + 1);
  assert.equal(accountLimitReason(d, 'acme', plan), 'rate_limited');
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

test('different accounts never affect each other\'s monthly count', () => {
  const d = db();
  const plan = planFeatures('verify');
  completeSpreadOverDays(d, 'acme', plan.reviewsPerMonth!);
  assert.equal(accountLimitReason(d, 'acme', plan), 'monthly_limit');
  assert.equal(accountLimitReason(d, 'other-co', plan), null, 'a fresh account is unaffected');
});
