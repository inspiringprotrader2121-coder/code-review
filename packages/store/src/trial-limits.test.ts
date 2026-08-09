import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppDatabase } from './database.js';

function db(): AppDatabase {
  return new AppDatabase(':memory:');
}

const testTenants = new WeakMap<AppDatabase, Map<string, string>>();
function tenantFor(d: AppDatabase, label = 'default'): string {
  let tenants = testTenants.get(d);
  if (!tenants) {
    tenants = new Map();
    testTenants.set(d, tenants);
  }
  let id = tenants.get(label);
  if (!id) {
    id = d.createTenant(`trial-${label}-${Math.random()}`).id;
    tenants.set(label, id);
  }
  return id;
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
    tenantId: tenantFor(d, opts.tenantId),
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

test('countAccountReviews counts running + completed + failed, excludes skipped/fix, per account', () => {
  const d = db();
  addReview(d, { owner: 'alice', status: 'completed' });
  addReview(d, { owner: 'alice', status: 'completed' });
  addReview(d, { owner: 'alice', status: 'running' }); // in-flight reserves a credit (anti-race)
  addReview(d, { owner: 'alice', status: 'skipped' }); // rate-limited/blocked don't burn a credit
  addReview(d, { owner: 'alice', status: 'failed' }); // post-spend failures still burn a credit
  addReview(d, { owner: 'alice', status: 'completed', action: 'fix:ready' }); // fixes aren't reviews
  addReview(d, { owner: 'bob', status: 'completed' }); // different account
  assert.equal(d.countAccountReviews('alice'), 4);
  assert.equal(d.countAccountReviews('bob'), 1);
});

test('pruneEphemeralData never deletes failed rows (lifetime trial anti-farm)', () => {
  const d = db();
  addReview(d, { owner: 'alice', status: 'failed' });
  addReview(d, { owner: 'alice', status: 'skipped' });
  assert.equal(d.countAccountReviews('alice'), 1);
  // Age both rows past the default 30d retention window.
  const old = new Date(Date.now() - 40 * 24 * 3_600_000).toISOString();
  (d as unknown as { db: { prepare: (sql: string) => { run: (...a: unknown[]) => unknown } } }).db
    .prepare(`UPDATE review_runs SET created_at = ?`)
    .run(old);
  d.pruneEphemeralData({ runRetentionMs: 30 * 24 * 3_600_000 });
  assert.equal(d.countAccountReviews('alice'), 1, 'failed lifetime rows survive prune');
});

test('pruning skipped runs also removes their usage ledger rows', () => {
  const d = db();
  const tenantId = tenantFor(d);
  const run = d.recordReviewRun({
    tenantId,
    installationId: 1,
    owner: 'alice',
    repo: 'r',
    pr: 2,
    headSha: 'sha-usage',
    action: 'synchronize',
    status: 'skipped',
    durationMs: 1,
  });
  d.recordReviewRunUsage({
    runId: run.id,
    tenantId,
    provider: 'test',
    model: 'test',
    tier: 'standard',
    inputTokens: 10,
    outputTokens: 5,
    inputRatePerM: 1,
    outputRatePerM: 1,
    costUsd: 0.000015,
    tokenSource: 'estimate',
  });
  const old = new Date(Date.now() - 40 * 24 * 3_600_000).toISOString();
  (d as unknown as { db: { prepare: (sql: string) => { run: (...a: unknown[]) => unknown } } }).db
    .prepare(`UPDATE review_runs SET created_at = ?`)
    .run(old);
  d.pruneEphemeralData({ runRetentionMs: 30 * 24 * 3_600_000 });
  assert.deepEqual(d.listReviewRunUsage(run.id), []);
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

test('countGlobalFreeTierReviewsSince counts only free-tier reviews across all accounts', () => {
  const d = db();
  // free-tier reviews from several accounts (a farm)
  d.recordReviewRun({ tenantId: tenantFor(d, 't1'), installationId: 1, owner: 'farm1', repo: 'r', pr: 1, headSha: 's', action: 'opened', status: 'completed', durationMs: 100, freeTier: true });
  d.recordReviewRun({ tenantId: tenantFor(d, 't2'), installationId: 2, owner: 'farm2', repo: 'r', pr: 1, headSha: 's', action: 'opened', status: 'running', durationMs: 100, freeTier: true });
  d.recordReviewRun({ tenantId: tenantFor(d, 't3'), installationId: 3, owner: 'farm3', repo: 'r', pr: 1, headSha: 's', action: 'opened', status: 'completed', durationMs: 100, freeTier: true });
  // a PAID review must NOT count toward the free-tier cap
  d.recordReviewRun({ tenantId: tenantFor(d, 'p1'), installationId: 9, owner: 'paying', repo: 'r', pr: 1, headSha: 's', action: 'opened', status: 'completed', durationMs: 100, freeTier: false });
  // a free-tier FIX / skipped run must NOT count
  d.recordReviewRun({ tenantId: tenantFor(d, 't4'), installationId: 4, owner: 'farm4', repo: 'r', pr: 1, headSha: 's', action: 'fix:ready', status: 'completed', durationMs: 100, freeTier: true });
  d.recordReviewRun({ tenantId: tenantFor(d, 't5'), installationId: 5, owner: 'farm5', repo: 'r', pr: 1, headSha: 's', action: 'opened', status: 'skipped', durationMs: 0, freeTier: true });
  d.recordReviewRun({ tenantId: tenantFor(d, 't6'), installationId: 6, owner: 'farm6', repo: 'r', pr: 1, headSha: 's', action: 'opened', status: 'failed', durationMs: 100, freeTier: true });
  assert.equal(d.countGlobalFreeTierReviewsSince(24 * 3600_000), 4, 'counts running+completed+failed free-tier reviews');
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

test('getUserByNormalizedEmail finds an account by its alias-collapsed identity (anti-farm)', () => {
  const d = db();
  // signup stores the normalized (alias-collapsed) identity
  const u = d.createPasswordUser({ email: 'John.Doe+work@gmail.com', passwordHash: 'scrypt$x$y', normalizedEmail: 'johndoe@gmail.com' });
  assert.ok(u);
  // a second signup with a DIFFERENT-looking alias of the same inbox is detected
  assert.ok(d.getUserByNormalizedEmail('johndoe@gmail.com'), 'alias of the same inbox is recognized');
  // an unrelated inbox is not
  assert.equal(d.getUserByNormalizedEmail('someoneelse@gmail.com'), null);
});

test('setUserNormalizedEmailIfMissing backfills only when absent (never overwrites)', () => {
  const d = db();
  const u = d.createPasswordUser({ email: 'a@b.com', passwordHash: 'scrypt$x$y' })!; // normalizedEmail defaults to email
  d.setUserNormalizedEmailIfMissing(u.id, 'different@x.com'); // should NOT overwrite existing
  assert.ok(d.getUserByNormalizedEmail('a@b.com'), 'existing normalized_email is preserved');
  assert.equal(d.getUserByNormalizedEmail('different@x.com'), null, 'did not overwrite');
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
