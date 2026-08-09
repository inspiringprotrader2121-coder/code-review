import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { MemoryReviewQueue, type ReviewJobPayload } from '@orvex-review/queue';
import { AppDatabase } from '@orvex-review/store';
import { testServerConfig } from './bootstrap/test-config.js';
import { startWorkerLoop } from './queue-runner.js';
import { webhookRoutes } from './routes/webhook.js';
import type { ProcessResult, WorkerConfig } from './pipeline.js';

const WEBHOOK_SECRET = 'five-pr-burst-test-secret';
const PRS = [274, 275, 276, 277, 278] as const;

test(
  'five high-tier webhook reviews reserve visible runs and drain independently',
  { timeout: 5_000 },
  async (t) => {
    const config = testServerConfig();
    const db = new AppDatabase(':memory:');
    const tenant = db.createTenant('burst-workspace');
    db.setTenantPlan(tenant.id, 'verify');
    db.upsertInstallation({
      installationId: 700,
      tenantId: tenant.id,
      accountLogin: 'acme',
      accountType: 'Organization',
    });
    db.upsertRepo({
      installationId: 700,
      tenantId: tenant.id,
      githubRepoId: 701,
      owner: 'acme',
      name: 'api',
      fullName: 'acme/api',
      enabled: true,
    });

    const lifecycle = new ReviewLifecycle(PRS.length);
    const queue = new ObservedQueue(lifecycle);
    const app = webhookRoutes(queue, {
      db,
      config,
      githubConfig: {
        appId: '1',
        privateKey: 'unused-in-injected-test',
        webhookSecret: WEBHOOK_SECRET,
        botLogin: 'orvex-review[bot]',
      },
    });

    const responses = await Promise.all(
      PRS.map((pr) => {
        const body = JSON.stringify(pullRequestPayload(pr));
        return app.request('/webhooks/github', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-github-event': 'pull_request',
            'x-github-delivery': `burst-delivery-${pr}`,
            'x-hub-signature-256': sign(body),
          },
          body,
        });
      }),
    );
    assert.deepEqual(
      responses.map((response) => response.status),
      [200, 200, 200, 200, 200],
    );
    const queuedResponses = await Promise.all(
      responses.map((response) => response.json() as Promise<{ reason?: string }>),
    );
    assert.deepEqual(
      queuedResponses.map((response) => response.reason),
      Array(PRS.length).fill('enqueued'),
    );
    const queuedDepth = await queue.depth();
    assert.equal(queuedDepth.queued, PRS.length);
    assert.equal(queuedDepth.waitingOnPr, 0);
    assert.equal(queuedDepth.inFlight, 0);
    assert.equal(typeof queuedDepth.oldestQueuedAt, 'string');

    const stop = startWorkerLoop(queue, {
      config,
      db,
      maxConcurrent: PRS.length,
      pollMs: 1,
      isDraining: () => false,
      loadConfig: () => ({ store: db }) as WorkerConfig,
      processReview: async (job, config): Promise<ProcessResult> => {
        assert.equal(db.getTenantPlan(job.tenantId), 'verify');
        const runId = db.startReviewRun({
          tenantId: job.tenantId,
          installationId: job.installationId,
          owner: job.owner,
          repo: job.repo,
          pr: job.pr,
          headSha: job.headSha,
          action: job.action,
        });
        job.runId = runId;
        await config.persistJob?.(job);
        lifecycle.started(job);
        await lifecycle.release;
        db.completeReviewRun(runId, { status: 'completed', durationMs: 1 });
        return { findingCount: 0, newCount: 0, fixedCount: 0 };
      },
    });
    t.after(async () => {
      lifecycle.open();
      await stop();
    });

    await lifecycle.allStarted;
    const running = db.listReviewRuns(tenant.id).filter((run) => run.status === 'running');
    assert.equal(running.length, PRS.length);
    assert.deepEqual(
      running.map((run) => run.pr).sort((a, b) => a - b),
      PRS,
    );
    assert.equal(new Set(running.map((run) => run.headSha)).size, PRS.length);
    assert.equal(queue.persistedRunIds.length, PRS.length);
    assert.equal(new Set(queue.persistedRunIds).size, PRS.length);
    assert.deepEqual(await queue.depth(), {
      queued: 0,
      waitingOnPr: 0,
      inFlight: PRS.length,
      oldestQueuedAt: null,
    });

    lifecycle.open();
    await lifecycle.allFinalized;
    assert.deepEqual(
      db
        .listReviewRuns(tenant.id)
        .map((run) => ({ pr: run.pr, status: run.status }))
        .sort((a, b) => a.pr - b.pr),
      PRS.map((pr) => ({ pr, status: 'completed' })),
    );
    assert.deepEqual(await queue.depth(), {
      queued: 0,
      waitingOnPr: 0,
      inFlight: 0,
      oldestQueuedAt: null,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await stop();
  },
);

class ReviewLifecycle {
  private startedCount = 0;
  private finalizedCount = 0;
  private released = false;
  private resolveRelease!: () => void;
  private resolveStarted!: () => void;
  private resolveFinalized!: () => void;

  readonly release = new Promise<void>((resolve) => {
    this.resolveRelease = resolve;
  });
  readonly allStarted = new Promise<void>((resolve) => {
    this.resolveStarted = resolve;
  });
  readonly allFinalized = new Promise<void>((resolve) => {
    this.resolveFinalized = resolve;
  });

  constructor(private readonly expected: number) {}

  started(_job: { pr: number }): void {
    this.startedCount += 1;
    assert.ok(
      this.startedCount <= this.expected,
      'worker started more reviews than the burst contains',
    );
    if (this.startedCount === this.expected) this.resolveStarted();
  }

  finalized(): void {
    this.finalizedCount += 1;
    assert.ok(
      this.finalizedCount <= this.expected,
      'worker finalized more reviews than the burst contains',
    );
    if (this.finalizedCount === this.expected) this.resolveFinalized();
  }

  open(): void {
    if (this.released) return;
    this.released = true;
    this.resolveRelease();
  }
}

class ObservedQueue extends MemoryReviewQueue {
  readonly persistedRunIds: string[] = [];

  constructor(private readonly lifecycle: ReviewLifecycle) {
    super();
  }

  override async persistJob(job: ReviewJobPayload): Promise<void> {
    assert.ok(job.runId, 'each running review must persist its reservation id');
    this.persistedRunIds.push(job.runId);
    await super.persistJob(job);
  }

  override async releaseLockAndDrain(key: string) {
    const next = await super.releaseLockAndDrain(key);
    this.lifecycle.finalized();
    return next;
  }
}

function pullRequestPayload(pr: number) {
  return {
    action: 'opened',
    installation: { id: 700, account: { login: 'acme', type: 'Organization' } },
    pull_request: {
      number: pr,
      title: `PR ${pr}`,
      state: 'open',
      draft: false,
      merged: false,
      html_url: `https://github.test/acme/api/pull/${pr}`,
      user: { login: 'developer' },
      head: { sha: `sha-${pr}` },
      created_at: '2026-08-09T12:00:00.000Z',
    },
    repository: {
      id: 701,
      name: 'api',
      full_name: 'acme/api',
      private: true,
      default_branch: 'main',
      owner: { login: 'acme' },
    },
    sender: { login: 'developer' },
  };
}

function sign(body: string): string {
  return `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex')}`;
}
