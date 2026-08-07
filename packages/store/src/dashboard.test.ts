import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppDatabase } from './database.js';
import type { StoredFinding } from './types.js';

function freshDb(): AppDatabase {
  return new AppDatabase(':memory:');
}

function seedTenant(db: AppDatabase) {
  const tenant = db.createTenant('acme', 'Acme');
  db.upsertInstallation({
    installationId: 100,
    tenantId: tenant.id,
    accountLogin: 'acme',
    accountType: 'Organization',
  });
  return tenant;
}

test('repos: upsert, list, enable toggle preserved across resync', () => {
  const db = freshDb();
  const tenant = seedTenant(db);

  const r = db.upsertRepo({
    installationId: 100,
    tenantId: tenant.id,
    githubRepoId: 5,
    owner: 'acme',
    name: 'api',
    fullName: 'acme/api',
    enabled: true,
  });
  assert.equal(r.enabled, true);
  assert.equal(db.isRepoEnabled(100, 'acme/api'), true);

  db.setRepoEnabled(r.id, false);
  assert.equal(db.isRepoEnabled(100, 'acme/api'), false);

  // a resync (e.g. webhook) must NOT re-enable a repo the user disabled
  db.upsertRepo({
    installationId: 100,
    tenantId: tenant.id,
    githubRepoId: 5,
    owner: 'acme',
    name: 'api',
    fullName: 'acme/api',
    enabled: true,
  });
  assert.equal(db.isRepoEnabled(100, 'acme/api'), false);

  // unknown repos default to enabled so reviews work before dashboard setup
  assert.equal(db.isRepoEnabled(100, 'acme/never-seen'), true);
});

test('repos: re-add after GitHub removal applies autoEnableNewRepos', () => {
  const db = freshDb();
  const tenant = seedTenant(db);

  const r = db.upsertRepo({
    installationId: 100,
    tenantId: tenant.id,
    githubRepoId: 5,
    owner: 'acme',
    name: 'api',
    fullName: 'acme/api',
    enabled: true,
  });
  assert.equal(db.disableRepoByGitHubId(100, 5), true);
  assert.equal(db.isRepoEnabled(100, 'acme/api'), false);

  // Mimic installation_repositories repositories_added: upsert then force-set
  // from workspace autoEnableNewRepos (default true).
  db.upsertRepo({
    installationId: 100,
    tenantId: tenant.id,
    githubRepoId: 5,
    owner: 'acme',
    name: 'api',
    fullName: 'acme/api',
    enabled: true,
  });
  assert.equal(db.isRepoEnabled(100, 'acme/api'), false, 'plain upsert still preserves disable');
  const settings = db.getWorkspaceSettings(tenant.id);
  db.setRepoEnabled(r.id, settings.autoEnableNewRepos);
  assert.equal(db.isRepoEnabled(100, 'acme/api'), true);

  db.setRepoEnabled(r.id, false);
  db.updateWorkspaceSettings(tenant.id, { autoEnableNewRepos: false });
  db.setRepoEnabled(r.id, db.getWorkspaceSettings(tenant.id).autoEnableNewRepos);
  assert.equal(db.isRepoEnabled(100, 'acme/api'), false);
});

test('pull requests: lifecycle states and counts', () => {
  const db = freshDb();
  const tenant = seedTenant(db);
  const base = { tenantId: tenant.id, installationId: 100, repoFullName: 'acme/api', author: 'dev', headSha: 'abc' };

  db.upsertPullRequest({ ...base, number: 1, title: 'open one', state: 'open' });
  db.upsertPullRequest({ ...base, number: 2, title: 'merge me', state: 'open' });
  // PR #2 gets merged
  db.upsertPullRequest({ ...base, number: 2, title: 'merge me', state: 'merged', mergedAt: '2026-07-04T00:00:00Z' });
  db.upsertPullRequest({ ...base, number: 3, title: 'closed one', state: 'closed' });

  const counts = db.getPullRequestCounts(tenant.id);
  assert.deepEqual(counts, { open: 1, merged: 1, closed: 1 });

  assert.equal(db.listPullRequests(tenant.id, { state: 'open' }).length, 1);
  assert.equal(db.listPullRequests(tenant.id, { state: 'merged' })[0].number, 2);
  assert.equal(db.listPullRequests(tenant.id).length, 3);
});

test('findings projection: saveState projects, resolved marks fixed, counts by status/severity', () => {
  const db = freshDb();
  const tenant = seedTenant(db);

  const mk = (fp: string, sev: string, status: 'open' | 'fixed'): StoredFinding => ({
    id: fp,
    fingerprint: fp,
    file: 'a.ts',
    line: 1,
    severity: sev,
    category: 'bug',
    message: `finding ${fp}`,
    confidence: 0.9,
    ruleId: 'llm.bug',
    status,
    firstSeenSha: 'abc',
    lastSeenSha: 'abc',
  });

  db.saveState({
    installationId: 100,
    tenantId: tenant.id,
    owner: 'acme',
    repo: 'api',
    pr: 1,
    lastSha: 'abc',
    findings: [mk('f1', 'P1', 'open'), mk('f2', 'P2', 'open'), mk('f3', 'P3', 'fixed')],
    lastReviewAt: '2026-07-04T00:00:00Z',
  });

  let counts = db.getFindingCounts(tenant.id);
  assert.equal(counts.open, 2);
  assert.equal(counts.fixed, 1);
  assert.deepEqual(counts.bySeverity, { P1: 1, P2: 1 });
  assert.equal(db.listFindings(tenant.id, { status: 'open' }).length, 2);
  // P1 sorts before P2
  assert.equal(db.listFindings(tenant.id, { status: 'open' })[0].severity, 'P1');

  // re-review marks f1 fixed → projection updates (no stale duplicates)
  db.saveState({
    installationId: 100,
    tenantId: tenant.id,
    owner: 'acme',
    repo: 'api',
    pr: 1,
    lastSha: 'def',
    findings: [mk('f1', 'P1', 'fixed'), mk('f2', 'P2', 'open'), mk('f3', 'P3', 'fixed')],
    lastReviewAt: '2026-07-04T01:00:00Z',
  });
  counts = db.getFindingCounts(tenant.id);
  assert.equal(counts.open, 1);
  assert.equal(counts.fixed, 2);
  assert.equal(db.listFindings(tenant.id).length, 3); // projection replaced, not appended
});

test('workspace settings: defaults and update', () => {
  const db = freshDb();
  const tenant = seedTenant(db);

  const def = db.getWorkspaceSettings(tenant.id);
  assert.equal(def.autoEnableNewRepos, true);
  assert.equal(def.maxComments, 8);

  const updated = db.updateWorkspaceSettings(tenant.id, { autoEnableNewRepos: false, maxComments: 5 });
  assert.equal(updated.autoEnableNewRepos, false);
  assert.equal(updated.maxComments, 5);
  assert.equal(db.getWorkspaceSettings(tenant.id).maxComments, 5);
});
