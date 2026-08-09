import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { MemoryReviewQueue, jobIdempotencyKey } from '@orvex-review/queue';
import { AppDatabase } from '@orvex-review/store';
import type { WorkerConfig } from './review/worker-types.js';
import { createApp } from './app.js';
import { githubAppConfig } from './bootstrap/config.js';
import { testServerConfig } from './bootstrap/test-config.js';
import { startWorkerLoop } from './queue-runner.js';

const WEBHOOK_SECRET = 'phase-zero-webhook-secret';

function sign(body: string): string {
  return `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex')}`;
}

async function waitFor(assertion: () => void, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw lastError ?? new Error('timed out waiting for deterministic worker result');
}

test('Phase 0 characterizes signed webhook through queue, bounded worker, durable run, and read model', async (t) => {
  const db = new AppDatabase(':memory:');
  const queue = new MemoryReviewQueue();
  const config = testServerConfig({
    GITHUB_APP_ID: 'phase-zero-app',
    GITHUB_APP_PRIVATE_KEY: 'phase-zero-private-key',
    GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
    ORVEX_MAX_CONCURRENT_REVIEWS: '1',
  });
  // Match a connected workspace: installation setup has already opted this
  // repository into automatic reviews before its first pull-request delivery.
  const tenant = db.createTenant('phase-zero');
  db.upsertInstallation({
    installationId: 417,
    tenantId: tenant.id,
    accountLogin: 'phase-zero',
    accountType: 'Organization',
    repositorySelection: 'selected',
  });
  db.upsertRepo({
    installationId: 417,
    tenantId: tenant.id,
    githubRepoId: 991,
    owner: 'phase-zero',
    name: 'deterministic-review',
    fullName: 'phase-zero/deterministic-review',
    enabled: true,
  });
  const app = createApp(queue, { db, config, githubConfig: githubAppConfig(config) });
  const modelCalls: string[] = [];
  let activeModelCalls = 0;
  let peakModelCalls = 0;

  const stopWorker = startWorkerLoop(queue, {
    config,
    db,
    maxConcurrent: 1,
    pollMs: 1,
    shutdownDrainMs: 100,
    loadConfig: () => ({ store: db, providerDependencies: {} }) as WorkerConfig,
    processReview: async (job) => {
      activeModelCalls++;
      peakModelCalls = Math.max(peakModelCalls, activeModelCalls);
      try {
        // This is deliberately the only model seam in the integration flow.
        // It makes the worker lifecycle deterministic and ensures no provider
        // credential, network request, or paid call can escape the test.
        modelCalls.push(`${job.owner}/${job.repo}#${job.pr}@${job.headSha}`);
        const runId = db.startReviewRun({
          tenantId: job.tenantId,
          installationId: job.installationId,
          owner: job.owner,
          repo: job.repo,
          pr: job.pr,
          headSha: job.headSha,
          action: job.action,
        });
        assert.equal(
          db.completeReviewRun(runId, {
            status: 'completed',
            durationMs: 7,
            findingsNew: 1,
            findingsOpen: 1,
            newFindings: [{ severity: 'P2', file: 'src/phase-zero.ts', line: 12 }],
          }),
          true,
        );
        return { findingCount: 1, newCount: 1, fixedCount: 0 };
      } finally {
        activeModelCalls--;
      }
    },
  });
  t.after(async () => {
    await stopWorker();
    await queue.close();
    db.close();
  });

  const payload = JSON.stringify({
    action: 'opened',
    installation: {
      id: 417,
      account: { login: 'phase-zero', type: 'Organization' },
      repository_selection: 'selected',
    },
    repository: {
      id: 991,
      name: 'deterministic-review',
      full_name: 'phase-zero/deterministic-review',
      private: true,
      default_branch: 'main',
      owner: { login: 'phase-zero' },
    },
    pull_request: {
      number: 73,
      title: 'Characterize the production boundary',
      state: 'open',
      draft: false,
      head: { sha: 'phase-zero-sha' },
      user: { login: 'author' },
    },
    sender: { login: 'author' },
  });

  const webhook = await app.request('/webhooks/github', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'pull_request',
      'x-github-delivery': 'phase-zero-delivery',
      'x-hub-signature-256': sign(payload),
    },
    body: payload,
  });
  assert.equal(webhook.status, 200);
  assert.equal(((await webhook.json()) as { reason: string }).reason, 'enqueued');

  const installation = db.getInstallation(417);
  assert.ok(installation, 'the signed webhook binds an installation before queueing');
  await waitFor(() => assert.equal(db.listReviewRuns(installation.tenantId).length, 1));

  const job = {
    installationId: 417,
    tenantId: installation.tenantId,
    owner: 'phase-zero',
    repo: 'deterministic-review',
    pr: 73,
    headSha: 'phase-zero-sha',
    action: 'opened' as const,
    priority: 0,
    enqueuedAt: '',
  };
  assert.equal(await queue.getJobState(jobIdempotencyKey(job)), 'succeeded');
  assert.deepEqual(modelCalls, ['phase-zero/deterministic-review#73@phase-zero-sha']);
  assert.equal(
    peakModelCalls,
    1,
    'the test worker is structurally bounded to one fake model runner',
  );

  const storedTenant = db.getTenantById(installation.tenantId);
  assert.ok(storedTenant);
  const dashboard = await app.request(`/dashboard/${storedTenant.slug}`);
  assert.equal(dashboard.status, 200);
  assert.match(await dashboard.text(), /Review runs/);

  const readModel = await app.request(`/api/workspaces/${storedTenant.slug}/reviews`);
  assert.equal(readModel.status, 200);
  const body = (await readModel.json()) as {
    workspace: string;
    reviews: Array<{ status: string; findingsNew: number }>;
  };
  assert.equal(body.workspace, storedTenant.slug);
  assert.deepEqual(
    body.reviews.map((run) => ({ status: run.status, findingsNew: run.findingsNew })),
    [{ status: 'completed', findingsNew: 1 }],
  );
});
