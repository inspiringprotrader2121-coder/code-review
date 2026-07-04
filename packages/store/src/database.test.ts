import { test } from 'node:test';
import assert from 'node:assert/strict';
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
