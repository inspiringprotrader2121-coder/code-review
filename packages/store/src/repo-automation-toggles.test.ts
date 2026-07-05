import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppDatabase } from './database.js';

function freshDb(): AppDatabase {
  return new AppDatabase(':memory:');
}

function seedRepo(db: AppDatabase) {
  const tenant = db.createTenant('acme', 'Acme');
  db.upsertInstallation({ installationId: 100, tenantId: tenant.id, accountLogin: 'acme', accountType: 'Organization' });
  const repo = db.upsertRepo({
    installationId: 100, tenantId: tenant.id, githubRepoId: 1, owner: 'acme', name: 'api', fullName: 'acme/api',
  });
  return { tenant, repo };
}

test('new repos default to reviewing on both open and push (matches old single-toggle behavior)', () => {
  const db = freshDb();
  const { repo } = seedRepo(db);
  assert.equal(repo.reviewOnOpen, true);
  assert.equal(repo.reviewOnPush, true);
});

test('isRepoActionEnabled: opened/reopened follow reviewOnOpen, synchronize follows reviewOnPush, independently', () => {
  const db = freshDb();
  const { repo } = seedRepo(db);
  db.updateRepoSettings(repo.id, { reviewOnPush: false });

  assert.equal(db.isRepoActionEnabled(100, 'acme/api', 'opened'), true, 'open still on');
  assert.equal(db.isRepoActionEnabled(100, 'acme/api', 'reopened'), true, 'reopened follows the open toggle');
  assert.equal(db.isRepoActionEnabled(100, 'acme/api', 'synchronize'), false, 'push toggle correctly off');

  db.updateRepoSettings(repo.id, { reviewOnPush: true, reviewOnOpen: false });
  assert.equal(db.isRepoActionEnabled(100, 'acme/api', 'opened'), false);
  assert.equal(db.isRepoActionEnabled(100, 'acme/api', 'synchronize'), true, 'push toggle unaffected by the open toggle');
});

test('an unknown repo defaults to enabled for both triggers (fresh install before dashboard visited)', () => {
  const db = freshDb();
  assert.equal(db.isRepoActionEnabled(999, 'nobody/nothing', 'opened'), true);
  assert.equal(db.isRepoActionEnabled(999, 'nobody/nothing', 'synchronize'), true);
});

test('updateRepoSettings can set reviewOnOpen/reviewOnPush independently of reviewMode/autoApply', () => {
  const db = freshDb();
  const { repo } = seedRepo(db);
  db.updateRepoSettings(repo.id, { reviewOnOpen: false });
  const after = db.listRepos(repo.tenantId).find((r) => r.id === repo.id)!;
  assert.equal(after.reviewOnOpen, false);
  assert.equal(after.reviewOnPush, true, 'untouched field stays at its previous value');
  assert.equal(after.reviewMode, 'normal', 'unrelated settings are untouched');
});

test('the overall repo `enabled` toggle is independent of the two trigger toggles', () => {
  const db = freshDb();
  const { repo } = seedRepo(db);
  db.setRepoEnabled(repo.id, false);
  const after = db.listRepos(repo.tenantId).find((r) => r.id === repo.id)!;
  assert.equal(after.enabled, false);
  assert.equal(after.reviewOnOpen, true, 'disabling the repo does not change the per-trigger settings');
  assert.equal(after.reviewOnPush, true);
});
