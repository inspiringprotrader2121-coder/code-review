import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryReviewQueue } from '@orvex-review/queue';
import { AppDatabase } from '@orvex-review/store';
import { testServerConfig } from '../../bootstrap/test-config.js';
import { createGithubWebhookEventService } from './github-webhook-event-service.js';

const githubConfig = {
  appId: 'event-matrix',
  privateKey: 'event-matrix-private-key',
  webhookSecret: 'event-matrix-secret',
  botLogin: 'orvex-review[bot]',
};

test('GitHub event matrix preserves installation sync and pull-request admission rules', async (t) => {
  const db = new AppDatabase(':memory:');
  const queue = new MemoryReviewQueue();
  t.after(async () => {
    await queue.close();
    db.close();
  });
  const tenant = db.createTenant('github-event-matrix');
  db.upsertInstallation({
    installationId: 7001,
    tenantId: tenant.id,
    accountLogin: 'acme',
    accountType: 'Organization',
    repositorySelection: 'selected',
  });
  const events = createGithubWebhookEventService(queue, {
    db,
    config: testServerConfig(),
    githubConfig,
  });

  const installationResult = await events.dispatch('installation_repositories', {
    action: 'added',
    installation: { id: 7001 },
    repositories_added: [
      { id: 81, name: 'api', full_name: 'acme/api', private: true, default_branch: 'main' },
    ],
  });
  assert.deepEqual(installationResult.body, { ok: true, action: 'added' });
  const repo = db.getRepoByGitHubId(7001, 81);
  assert.ok(repo);
  assert.equal(repo.enabled, true, 'new repositories honour the workspace auto-enable toggle');

  const fiveOpened = await Promise.all(
    [1, 2, 3, 4, 5].map((pr) => events.dispatch('pull_request', pullRequest(pr))),
  );
  assert.deepEqual(
    fiveOpened.map((result) => result.body.reason),
    ['enqueued', 'enqueued', 'enqueued', 'enqueued', 'enqueued'],
  );
  const queued = await queue.depth();
  assert.equal(queued.queued, 5);
  assert.equal(queued.waitingOnPr, 0);
  assert.equal(queued.inFlight, 0);
  assert.equal(typeof queued.oldestQueuedAt, 'string');

  const botPush = await events.dispatch(
    'pull_request',
    pullRequest(6, { action: 'synchronize', sender: 'orvex-review[bot]' }),
  );
  assert.equal(botPush.body.reason, 'own_commit');
  assert.equal(
    (await queue.depth()).queued,
    5,
    'bot-authored fix pushes never create a paid re-review',
  );

  const draft = await events.dispatch('pull_request', pullRequest(7, { draft: true }));
  assert.equal(
    draft.body.reason,
    'enqueued',
    'draft lifecycle events remain visible to the worker',
  );
  assert.equal((await queue.depth()).queued, 6);

  db.setRepoEnabled(repo.id, false);
  const disabled = await events.dispatch('pull_request', pullRequest(8));
  assert.equal(disabled.body.reason, 'repo_disabled');
  assert.equal((await queue.depth()).queued, 6, 'a disabled repository never spends a review slot');
});

function pullRequest(
  pr: number,
  overrides: { action?: string; sender?: string; draft?: boolean } = {},
): Record<string, unknown> {
  return {
    action: overrides.action ?? 'opened',
    installation: {
      id: 7001,
      account: { login: 'acme', type: 'Organization' },
      repository_selection: 'selected',
    },
    repository: { id: 81, name: 'api', full_name: 'acme/api', owner: { login: 'acme' } },
    pull_request: {
      number: pr,
      title: `PR ${pr}`,
      state: 'open',
      draft: overrides.draft ?? false,
      head: { sha: `sha-${pr}` },
      user: { login: 'author' },
    },
    sender: { login: overrides.sender ?? 'author' },
  };
}
