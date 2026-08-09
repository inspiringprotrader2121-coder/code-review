import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppDatabase } from '@orvex-review/store';
import { planFeatures } from '@orvex-review/tenants';
import {
  formatLimitBlockedComment,
  formatQuotaStatusComment,
  loadAccountQuotaStatus,
  MS_PER_HOUR,
} from './quota-status.js';

function db(): AppDatabase {
  const d = new AppDatabase(':memory:');
  defaultTenants.set(d, d.createTenant(`quota-${Math.random()}`).id);
  return d;
}

const defaultTenants = new WeakMap<AppDatabase, string>();
const defaultTenant = (d: AppDatabase): string => defaultTenants.get(d)!;

function complete(
  d: AppDatabase,
  owner: string,
  n: number,
  opts: { createdAt?: string; tenantId?: string } = {},
): void {
  for (let i = 0; i < n; i++) {
    d.recordReviewRun({
      tenantId: opts.tenantId ?? defaultTenant(d),
      installationId: 1,
      owner,
      repo: 'r',
      pr: 1,
      headSha: `sha${i}-${opts.createdAt ?? 'now'}`,
      action: 'synchronize',
      status: 'completed',
      durationMs: 1000,
      createdAt: opts.createdAt,
    });
  }
}

test('oldestAccountReviewCreatedAt returns the earliest review in the window', () => {
  const d = db();
  const older = new Date(Date.now() - 40 * 60_000).toISOString();
  const newer = new Date(Date.now() - 10 * 60_000).toISOString();
  complete(d, 'acme', 1, { createdAt: newer });
  complete(d, 'acme', 1, { createdAt: older });
  assert.equal(d.oldestAccountReviewCreatedAt('acme', MS_PER_HOUR), older);
});

test('loadAccountQuotaStatus reports hourly remaining and next slot when exhausted', () => {
  const d = db();
  const plan = planFeatures('review');
  const oldest = new Date(Date.now() - 20 * 60_000).toISOString();
  complete(d, 'acme', plan.reviewsPerHour!, { createdAt: oldest });
  const status = loadAccountQuotaStatus(d, 'acme', defaultTenant(d), plan);
  assert.equal(status.hourly.used, plan.reviewsPerHour);
  assert.equal(status.hourly.remaining, 0);
  assert.ok(status.hourly.nextSlotAt);
  assert.equal(
    new Date(status.hourly.nextSlotAt!).getTime(),
    new Date(oldest).getTime() + MS_PER_HOUR,
  );
  assert.equal(status.monthly.kind, 'metered');
  if (status.monthly.kind === 'metered') {
    assert.equal(status.monthly.included, 100);
  }
});

test('formatQuotaStatusComment includes plan, hourly, and dashboard tip', () => {
  const d = db();
  const status = loadAccountQuotaStatus(d, 'acme', defaultTenant(d), planFeatures('review-plus'));
  const body = formatQuotaStatusComment(status, '@orvex');
  assert.match(body, /\*\*Plan:\*\* Pro/);
  assert.match(body, /Hourly:/);
  assert.match(body, /Monthly \(hard cap\):/);
  assert.match(body, /500/);
  assert.match(body, /Prepaid overage/);
  assert.match(body, /Run on each commit/);
  assert.match(body, /@orvex review/);
});

test('formatLimitBlockedComment for rate_limited is explicit about used/limit and wait', () => {
  const d = db();
  const plan = planFeatures('review');
  const oldest = new Date(Date.now() - 15 * 60_000).toISOString();
  complete(d, 'acme', 5, { createdAt: oldest });
  const status = loadAccountQuotaStatus(d, 'acme', defaultTenant(d), plan);
  const body = formatLimitBlockedComment(status, 'rate_limited', '@orvex');
  assert.match(body, /hourly limit reached/i);
  assert.match(body, /5 \/ 5/);
  assert.match(body, /not\*\* reviewed/i);
  assert.match(body, /@orvex rate limit/);
  assert.match(body, /Run on each commit/);
});

test('formatLimitBlockedComment for trial_exhausted points at upgrade', () => {
  const d = db();
  const plan = planFeatures('free');
  complete(d, 'newbie', 10);
  const status = loadAccountQuotaStatus(d, 'newbie', defaultTenant(d), plan);
  const body = formatLimitBlockedComment(status, 'trial_exhausted', '@orvex');
  assert.match(body, /free trial used up/i);
  assert.match(body, /10/);
  assert.match(body, /useorvex\.com\/#pricing/);
});
