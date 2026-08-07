import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { AppDatabase } from './database.js';

function freshDb(): AppDatabase {
  return new AppDatabase(':memory:');
}

test('users: upsert by github id updates profile, keeps id', () => {
  const db = freshDb();
  const a = db.upsertUserFromGitHub({ githubId: 42, login: 'octocat' });
  const b = db.upsertUserFromGitHub({ githubId: 42, login: 'octocat-renamed', name: 'Octo' });
  assert.equal(a.id, b.id);
  assert.equal(b.login, 'octocat-renamed');
  assert.equal(b.name, 'Octo');
});

test('stale-run cleanup leaves fresh running work alone during a rolling restart', () => {
  const db = freshDb();
  const tenant = db.createTenant('live-worker');
  db.startReviewRun({
    tenantId: tenant.id,
    installationId: 1,
    owner: 'live-worker',
    repo: 'api',
    pr: 1,
    headSha: 'live',
    action: 'synchronize',
  });
  assert.equal(db.failStaleRunningRuns({ staleAfterMs: 60 * 60_000 }), 0);
});

test('sole-worker boot interrupts all running rows so resume can reopen them', () => {
  const db = freshDb();
  const tenant = db.createTenant('sole-worker');
  const runId = db.startReviewRun({
    tenantId: tenant.id,
    installationId: 1,
    owner: 'sole-worker',
    repo: 'api',
    pr: 1,
    headSha: 'fresh',
    action: 'synchronize',
  });
  assert.equal(db.failStaleRunningRuns({ staleAfterMs: 0 }), 1);
  assert.equal(
    db.resumeReviewRun(runId, {
      tenantId: tenant.id,
      installationId: 1,
      owner: 'sole-worker',
      repo: 'api',
      pr: 1,
      action: 'synchronize',
    }),
    'resumed',
  );
});

test('interruptReviewRun marks running rows so resumeReviewRun can reopen them', () => {
  const db = freshDb();
  const tenant = db.createTenant('interrupt');
  const input = {
    tenantId: tenant.id,
    installationId: 9,
    owner: 'interrupt',
    repo: 'api',
    pr: 3,
    headSha: 'abc',
    action: 'synchronize' as const,
  };
  const runId = db.startReviewRun(input);
  assert.equal(db.interruptReviewRun(runId), true);
  assert.equal(db.interruptReviewRun(runId), false, 'already interrupted');
  assert.equal(
    db.resumeReviewRun(runId, {
      tenantId: input.tenantId,
      installationId: input.installationId,
      owner: input.owner,
      repo: input.repo,
      pr: input.pr,
      action: input.action,
    }),
    'resumed',
  );
});

test('durable storage rejects database files anywhere inside the checkout', () => {
  const previous = process.env.ORVEX_REQUIRE_DURABLE_STORAGE;
  process.env.ORVEX_REQUIRE_DURABLE_STORAGE = '1';
  try {
    assert.throws(
      () => new AppDatabase(path.join(process.cwd(), 'velatrix-review.db')),
      /outside the checkout/,
    );
  } finally {
    if (previous === undefined) delete process.env.ORVEX_REQUIRE_DURABLE_STORAGE;
    else process.env.ORVEX_REQUIRE_DURABLE_STORAGE = previous;
  }
});

test('installation upsert never rebinds an existing installation to another tenant', () => {
  const db = freshDb();
  const first = db.createTenant('first');
  const second = db.createTenant('second');
  db.upsertInstallation({ installationId: 7, tenantId: first.id, accountLogin: 'org', accountType: 'Organization' });
  const result = db.upsertInstallation({
    installationId: 7,
    tenantId: second.id,
    accountLogin: 'org-renamed',
    accountType: 'Organization',
  });
  assert.equal(result.tenantId, first.id);
  assert.equal(result.accountLogin, 'org-renamed');
});

test('sessions: valid session resolves user, expired session is rejected', () => {
  const db = freshDb();
  const user = db.upsertUserFromGitHub({ githubId: 1, login: 'alice' });

  const live = db.createSession(user.id);
  assert.equal(db.getSessionUser(live.id)?.id, user.id);

  const expired = db.createSession(user.id, -1000);
  assert.equal(db.getSessionUser(expired.id), null);

  db.deleteSession(live.id);
  assert.equal(db.getSessionUser(live.id), null);
});

test('membership: owners, member listing, member-less tenants are claimable', () => {
  const db = freshDb();
  const alice = db.upsertUserFromGitHub({ githubId: 1, login: 'alice' });
  const bob = db.upsertUserFromGitHub({ githubId: 2, login: 'bob' });
  const tenant = db.createTenant('acme', 'Acme Corp');

  assert.equal(db.tenantHasMembers(tenant.id), false);
  db.addWorkspaceMember(tenant.id, alice.id, 'owner');
  assert.equal(db.tenantHasMembers(tenant.id), true);

  assert.equal(db.getMembership(tenant.id, alice.id)?.role, 'owner');
  assert.equal(db.getMembership(tenant.id, bob.id), null);

  const workspaces = db.getWorkspacesForUser(alice.id);
  assert.equal(workspaces.length, 1);
  assert.equal(workspaces[0].tenant.slug, 'acme');
  assert.equal(workspaces[0].role, 'owner');
});

test('paid access downgrades on explicit dunning status and durable webhook claims dedupe across workers', () => {
  const db = freshDb();
  const tenant = db.createTenant('billing');
  db.setTenantPlan(tenant.id, 'review');
  db.setTenantBilling(tenant.id, { stripeSubscriptionStatus: 'past_due' });
  assert.equal(db.getTenantPlan(tenant.id), 'free');

  db.setTenantBilling(tenant.id, { stripeSubscriptionStatus: 'active' });
  assert.equal(db.getTenantPlan(tenant.id), 'review');

  const stripeClaim = db.claimWebhookEvent('stripe', 'evt_1');
  assert.ok(stripeClaim);
  assert.equal(db.claimWebhookEvent('stripe', 'evt_1'), null);
  db.completeWebhookEvent('stripe', 'evt_1', stripeClaim);
  assert.equal(db.claimWebhookEvent('stripe', 'evt_1'), null);
  assert.ok(db.claimWebhookEvent('github', 'evt_1'), 'providers use independent delivery namespaces');

  const runId = db.startReviewRun({
    tenantId: tenant.id,
    installationId: 7,
    owner: 'billing',
    repo: 'api',
    pr: 1,
    headSha: 'abc',
    action: 'synchronize',
  });
  assert.equal(db.failStaleRunningRuns({ staleAfterMs: 0 }), 1);
  assert.equal(db.countAccountReviews('billing'), 1, 'an interrupted attempt remains quota-consuming');
  assert.equal(
    db.resumeReviewRun(runId, {
      tenantId: tenant.id,
      installationId: 7,
      owner: 'billing',
      repo: 'api',
      pr: 1,
      action: 'synchronize',
    }),
    'resumed',
  );
  db.completeReviewRun(runId, { status: 'completed', durationMs: 1 });
  assert.equal(
    db.resumeReviewRun(runId, {
      tenantId: tenant.id,
      installationId: 7,
      owner: 'billing',
      repo: 'api',
      pr: 1,
      action: 'synchronize',
    }),
    'completed',
  );
});

test('retention removes abandoned webhook claims so the event ledger stays bounded', () => {
  const db = freshDb();
  const firstClaim = db.claimWebhookEvent('github', 'stale-event');
  assert.ok(firstClaim);
  const old = new Date(Date.now() - 2 * 24 * 3_600_000).toISOString();
  (db as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } } }).db
    .prepare(`UPDATE webhook_events SET claimed_at = ?`)
    .run(old);

  assert.equal(db.pruneEphemeralData(), 1);
  const reclaimed = db.claimWebhookEvent('github', 'stale-event');
  assert.ok(reclaimed);
  assert.notEqual(reclaimed, firstClaim);
  db.completeWebhookEvent('github', 'stale-event', firstClaim);
  assert.equal(db.getWebhookEvent('github', 'stale-event')?.processedAt, undefined);
  db.completeWebhookEvent('github', 'stale-event', reclaimed);
  assert.ok(db.getWebhookEvent('github', 'stale-event')?.processedAt);
});

test('body-hash claims dedupe replays inside the TTL and reopen after it', () => {
  const db = freshDb();
  const hash = 'a'.repeat(64);
  const first = db.claimWebhookBodyHash('github', hash, { ttlMs: 60_000 });
  assert.ok(first);
  assert.equal(db.claimWebhookBodyHash('github', hash, { ttlMs: 60_000 }), null, 'in-flight blocks');
  db.completeWebhookEvent(db.webhookBodyProvider('github'), hash, first);
  assert.equal(
    db.claimWebhookBodyHash('github', hash, { ttlMs: 60_000 }),
    null,
    'processed body hash blocks inside TTL',
  );

  const expired = new Date(Date.now() - 120_000).toISOString();
  (db as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } } }).db
    .prepare(`UPDATE webhook_events SET processed_at = ?, claimed_at = ? WHERE provider = ? AND event_id = ?`)
    .run(expired, expired, db.webhookBodyProvider('github'), hash);

  const afterTtl = db.claimWebhookBodyHash('github', hash, { ttlMs: 60_000 });
  assert.ok(afterTtl, 'TTL expiry allows a fresh claim');
  assert.notEqual(afterTtl, first);
});

test('review runs: recorded and aggregated into workspace stats', () => {
  const db = freshDb();
  const tenant = db.createTenant('acme');

  const base = {
    tenantId: tenant.id,
    installationId: 100,
    owner: 'acme',
    repo: 'api',
    pr: 1,
    headSha: 'abc1234',
    action: 'opened',
  };

  db.recordReviewRun({
    ...base,
    status: 'completed',
    durationMs: 1000,
    findingsNew: 3,
    findingsFixed: 1,
    findingsOpen: 3,
  });
  db.recordReviewRun({
    ...base,
    pr: 2,
    status: 'completed',
    durationMs: 3000,
    findingsNew: 1,
    findingsFixed: 2,
    findingsOpen: 0,
  });
  db.recordReviewRun({ ...base, pr: 3, status: 'skipped', skipReason: 'draft', durationMs: 50 });
  db.recordReviewRun({ ...base, pr: 4, status: 'failed', error: 'boom', durationMs: 200 });

  const runs = db.listReviewRuns(tenant.id);
  assert.equal(runs.length, 4);
  assert.equal(runs.filter((r) => r.status === 'completed').length, 2);
  assert.equal(runs.find((r) => r.status === 'skipped')?.skipReason, 'draft');

  const stats = db.getWorkspaceStats(tenant.id, 14);
  assert.equal(stats.runsTotal, 4);
  assert.equal(stats.runsCompleted, 2);
  assert.equal(stats.runsSkipped, 1);
  assert.equal(stats.runsFailed, 1);
  assert.equal(stats.findingsNew, 4);
  assert.equal(stats.findingsFixed, 3);
  // avg duration only counts completed runs
  assert.equal(stats.avgDurationMs, 2000);

  // other tenants see nothing
  const other = db.createTenant('other');
  assert.equal(db.getWorkspaceStats(other.id, 14).runsTotal, 0);
  assert.equal(db.listReviewRuns(other.id).length, 0);
});

test('review runs: setReviewRunHeadSha re-points a run at the effective SHA', () => {
  const db = freshDb();
  const tenant = db.createTenant('acme');
  const runId = db.startReviewRun({
    tenantId: tenant.id,
    installationId: 1,
    owner: 'acme',
    repo: 'api',
    pr: 7,
    headSha: 'stale-sha-from-webhook',
    action: 'synchronize',
  });
  // The PR head moved between enqueue and execution — record on the real SHA.
  db.setReviewRunHeadSha(runId, 'effective-sha');
  db.completeReviewRun(runId, { status: 'completed', durationMs: 10 });

  // Cooldown keys on head_sha: the EFFECTIVE sha must hit, the stale one must not.
  assert.notEqual(db.secondsSinceLastCompletedReview(1, 'acme', 'api', 7, 'effective-sha'), null);
  assert.equal(db.secondsSinceLastCompletedReview(1, 'acme', 'api', 7, 'stale-sha-from-webhook'), null);
});

test('repos: upsert refreshes tenant_id when an installation is re-linked', () => {
  const db = freshDb();
  const t1 = db.createTenant('one');
  const t2 = db.createTenant('two');
  const base = { installationId: 7, githubRepoId: 99, owner: 'acme', name: 'api', fullName: 'acme/api' };

  db.upsertRepo({ ...base, tenantId: t1.id });
  assert.equal(db.getRepoByGitHubId(7, 99)?.tenantId, t1.id);

  // installation re-linked to a different tenant → the repo must follow
  db.upsertRepo({ ...base, tenantId: t2.id });
  assert.equal(db.getRepoByGitHubId(7, 99)?.tenantId, t2.id);
  assert.equal(db.listRepos(t1.id).length, 0);
  assert.equal(db.listRepos(t2.id).length, 1);

  assert.equal(db.disableRepoByGitHubId(7, 99), true);
  assert.equal(db.getRepoByGitHubId(7, 99)?.enabled, false);
  assert.equal(db.disableReposForInstallation(7), 0, 'already-disabled repos are not counted twice');
});

test('manual-review candidates round-trip separately from findings', () => {
  // They are persisted ONLY so `@orvex ignore <file>:<line>` can resolve them:
  // a manual candidate has no inline comment, so the thread-reply form of
  // `ignore` (which matches on githubCommentId) could never reach it and the
  // noise repeated on every push forever. They must stay OUT of `findings` so
  // they never reach the dashboard projection or the new/open/fixed stats.
  const db = freshDb();
  const key = { installationId: 1, owner: 'o', repo: 'r', pr: 5 };
  db.saveState({
    installationId: 1,
    tenantId: 't',
    owner: 'o',
    repo: 'r',
    pr: 5,
    lastSha: 'sha1',
    findings: [],
    lastReviewAt: new Date().toISOString(),
    manualReview: [
      {
        id: 'm1',
        fingerprint: 'fp-manual-1',
        file: 'src/a.ts',
        line: 42,
        severity: 'P1',
        category: 'logic',
        message: 'unconfirmed candidate',
        confidence: 0.3,
        ruleId: 'llm.general',
        status: 'open',
        firstSeenSha: 'sha1',
      } as never,
    ],
  });
  const back = db.getState(key);
  assert.equal(back?.manualReview?.length, 1);
  assert.equal(back?.manualReview?.[0]?.fingerprint, 'fp-manual-1');
  assert.deepEqual(back?.findings, [], 'manual candidates must not leak into findings');
});

test('a pr_reviews row written before manual_review_json existed still loads', () => {
  // Guards the ALTER-TABLE migration: the live DB predates this column, and a
  // failure here would break every existing PR's state on deploy.
  const db = freshDb();
  const key = { installationId: 2, owner: 'o', repo: 'r', pr: 7 };
  db.saveState({
    installationId: 2,
    tenantId: 't',
    owner: 'o',
    repo: 'r',
    pr: 7,
    lastSha: 'sha1',
    findings: [],
    lastReviewAt: new Date().toISOString(),
  });
  const back = db.getState(key);
  assert.ok(back, 'state without manualReview must still load');
  assert.equal(back?.manualReview, undefined);
});
