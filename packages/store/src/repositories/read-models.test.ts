import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppDatabase } from '../database.js';
import { RepositoryReadRepository } from './repository-read.js';
import { WorkspaceReadRepository } from './workspace-read.js';

function repositories(db: AppDatabase): {
  repositoryReads: RepositoryReadRepository;
  workspaceReads: WorkspaceReadRepository;
} {
  const raw = (db as unknown as { db: ConstructorParameters<typeof RepositoryReadRepository>[0] })
    .db;
  return {
    repositoryReads: new RepositoryReadRepository(raw),
    workspaceReads: new WorkspaceReadRepository(raw),
  };
}

test('workspace read repository is tenant-scoped and preserves facade dashboard projections', () => {
  const db = new AppDatabase(':memory:');
  const first = db.createTenant('workspace-first');
  const second = db.createTenant('workspace-second');
  db.upsertPullRequest({
    tenantId: first.id,
    installationId: 1,
    repoFullName: 'first/api',
    number: 1,
    title: 'First',
    author: 'alice',
    state: 'open',
    headSha: 'first-sha',
  });
  db.upsertPullRequest({
    tenantId: second.id,
    installationId: 2,
    repoFullName: 'second/api',
    number: 1,
    title: 'Second',
    author: 'bob',
    state: 'merged',
    headSha: 'second-sha',
  });
  const firstRun = db.startReviewRun({
    tenantId: first.id,
    installationId: 1,
    owner: 'first',
    repo: 'api',
    pr: 1,
    headSha: 'first-sha',
    action: 'manual',
  });
  db.completeReviewRun(firstRun, {
    status: 'completed',
    durationMs: 12,
    findingsNew: 1,
    costUsd: 0.02,
  });
  db.projectFindings(
    { tenantId: first.id, installationId: 1, owner: 'first', repo: 'api', pr: 1 },
    [
      {
        id: 'finding',
        fingerprint: 'first-finding',
        file: 'src/a.ts',
        severity: 'P1',
        category: 'bug',
        message: 'first',
        confidence: 1,
        ruleId: 'rule',
        status: 'open',
        firstSeenSha: 'first-sha',
        lastSeenSha: 'first-sha',
      },
    ],
  );
  db.updateWorkspaceSettings(first.id, { maxComments: 12 });

  const { workspaceReads } = repositories(db);
  assert.deepEqual(workspaceReads.listReviewRuns(first.id), db.listReviewRuns(first.id));
  assert.deepEqual(workspaceReads.getWorkspaceStats(first.id), db.getWorkspaceStats(first.id));
  assert.deepEqual(workspaceReads.listPullRequests(first.id), db.listPullRequests(first.id));
  assert.deepEqual(
    workspaceReads.getPullRequestCounts(first.id),
    db.getPullRequestCounts(first.id),
  );
  assert.deepEqual(workspaceReads.listFindings(first.id), db.listFindings(first.id));
  assert.deepEqual(workspaceReads.getFindingCounts(first.id), db.getFindingCounts(first.id));
  assert.deepEqual(
    workspaceReads.getWorkspaceSettings(first.id),
    db.getWorkspaceSettings(first.id),
  );
  assert.equal(workspaceReads.listReviewRuns(second.id).length, 0);
  assert.equal(workspaceReads.listPullRequests(second.id)[0]?.title, 'Second');
  assert.equal(workspaceReads.listFindings(second.id).length, 0);
  db.close();
});

test('repository read repository is explicitly installation-scoped and tenant list scoped', () => {
  const db = new AppDatabase(':memory:');
  const first = db.createTenant('repo-first');
  const second = db.createTenant('repo-second');
  const firstRepo = db.upsertRepo({
    installationId: 10,
    tenantId: first.id,
    githubRepoId: 99,
    owner: 'first',
    name: 'api',
    fullName: 'first/api',
  });
  db.upsertRepo({
    installationId: 20,
    tenantId: second.id,
    githubRepoId: 99,
    owner: 'second',
    name: 'api',
    fullName: 'second/api',
  });

  const { repositoryReads } = repositories(db);
  assert.deepEqual(repositoryReads.getByGitHubId(10, 99), db.getRepoByGitHubId(10, 99));
  assert.deepEqual(
    repositoryReads.getByFullName(10, 'FIRST/API'),
    db.getRepoByFullName(10, 'FIRST/API'),
  );
  assert.deepEqual(repositoryReads.listForTenant(first.id), db.listRepos(first.id));
  assert.equal(repositoryReads.getByGitHubId(20, firstRepo.githubRepoId)?.tenantId, second.id);
  assert.equal(repositoryReads.getByFullName(10, 'second/api'), null);
  assert.equal(repositoryReads.listForTenant(second.id).length, 1);
  db.close();
});
