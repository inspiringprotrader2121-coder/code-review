import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppDatabase } from './database.js';

function db(): AppDatabase {
  return new AppDatabase(':memory:');
}

function addReview(
  d: AppDatabase,
  opts: {
    owner: string;
    tenantId?: string;
    status: 'running' | 'completed' | 'skipped' | 'failed';
    action?: string;
  },
): void {
  d.recordReviewRun({
    tenantId: opts.tenantId ?? 't1',
    installationId: 1,
    owner: opts.owner,
    repo: 'r',
    pr: 1,
    headSha: 'sha',
    action: opts.action ?? 'synchronize',
    status: opts.status,
    durationMs: 1000,
  });
}

test('countAccountReviews counts running + completed, excludes failed/skipped/fix, per account', () => {
  const d = db();
  addReview(d, { owner: 'alice', status: 'completed' });
  addReview(d, { owner: 'alice', status: 'completed' });
  addReview(d, { owner: 'alice', status: 'running' }); // in-flight reserves a credit (anti-race)
  addReview(d, { owner: 'alice', status: 'skipped' }); // rate-limited/blocked don't burn a credit
  addReview(d, { owner: 'alice', status: 'failed' }); // failures don't burn a credit
  addReview(d, { owner: 'alice', status: 'completed', action: 'fix:ready' }); // fixes aren't reviews
  addReview(d, { owner: 'bob', status: 'completed' }); // different account
  assert.equal(d.countAccountReviews('alice'), 3);
  assert.equal(d.countAccountReviews('bob'), 1);
});

test('countAccountReviews matches the account case-insensitively', () => {
  const d = db();
  addReview(d, { owner: 'Alice', status: 'completed' });
  addReview(d, { owner: 'alice', status: 'completed' });
  assert.equal(d.countAccountReviews('ALICE'), 2, 'GitHub logins are case-insensitive');
});

test('trial is anchored to the GitHub account, not the workspace — a second workspace cannot reset it', () => {
  const d = db();
  addReview(d, { owner: 'alice', tenantId: 'workspace-1', status: 'completed' });
  addReview(d, { owner: 'alice', tenantId: 'workspace-2', status: 'completed' });
  assert.equal(d.countAccountReviews('alice'), 2, 'both workspaces count against the same account');
});

test('countDistinctAccountsFromIp counts unique accounts and ignores unknown IPs', () => {
  const d = db();
  d.recordAbuseSignal({ ip: '1.2.3.4', accountLogin: 'acc1', kind: 'install' });
  d.recordAbuseSignal({ ip: '1.2.3.4', accountLogin: 'acc2', kind: 'install' });
  d.recordAbuseSignal({ ip: '1.2.3.4', accountLogin: 'acc2', kind: 'install' }); // duplicate account
  d.recordAbuseSignal({ ip: '9.9.9.9', accountLogin: 'acc3', kind: 'install' });
  assert.equal(d.countDistinctAccountsFromIp('1.2.3.4', 24 * 3600_000), 2);
  assert.equal(d.countDistinctAccountsFromIp('9.9.9.9', 24 * 3600_000), 1);
  assert.equal(d.countDistinctAccountsFromIp('unknown', 24 * 3600_000), 0);
});

test('new tenants start on the free trial, not a paid tier', () => {
  const prev = process.env.ORVEX_DEFAULT_PLAN;
  delete process.env.ORVEX_DEFAULT_PLAN;
  try {
    const d = db();
    const t = d.createTenant('newco');
    assert.equal(d.getTenantPlan(t.id), 'free');
  } finally {
    if (prev !== undefined) process.env.ORVEX_DEFAULT_PLAN = prev;
  }
});
