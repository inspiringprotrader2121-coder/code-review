import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MemoryProviderAdmission,
  MemoryReviewQueue,
  type ProviderAdmission,
  type ReviewJobPayload,
} from '@orvex-review/queue';
import { compileReviewPlan, type ReviewStage } from '@orvex-review/review';
import { AppDatabase } from '@orvex-review/store';
import { testServerConfig } from './bootstrap/test-config.js';
import type { ProcessResult, WorkerConfig } from './pipeline.js';
import { startWorkerLoop } from './queue-runner.js';

const REVIEW_COUNT = 400;

test(
  'production capacity profile drains 400 queued high-tier reviews within bounded provider and sandbox slots',
  { timeout: 30_000 },
  async (t) => {
    const config = testServerConfig({
      ORVEX_CODEX_CLI: '1',
      ORVEX_MAX_CONCURRENT_REVIEWS: '8',
      ORVEX_CODEX_APIKEY_CONCURRENCY: '8',
      ORVEX_PROVIDER_CONCURRENCY_LUNA: '8',
      ORVEX_PROVIDER_CONCURRENCY_DEEPSEEK: '64',
      ORVEX_PROVIDER_CONCURRENCY_MINIMAX: '32',
      ORVEX_VERIFY_CONCURRENCY: '8',
      ORVEX_REVIEW_CONCURRENCY: '8',
      ORVEX_MAX_SANDBOXES: '8',
    });
    assert.deepEqual(
      {
        reviews: config.worker.concurrency,
        luna: config.review.providerConcurrency('luna'),
        minimax: config.review.providerConcurrency('minimax'),
        deepseek: config.review.providerConcurrency('deepseek'),
        verify: config.review.verifyConcurrency,
        sandboxes: config.sandbox.sandbox.maxConcurrentSandboxes,
      },
      { reviews: 8, luna: 8, minimax: 32, deepseek: 64, verify: 8, sandboxes: 8 },
    );

    const db = new AppDatabase(':memory:');
    const tenant = db.createTenant('capacity-stress-workspace');
    db.setTenantPlan(tenant.id, 'verify');
    db.upsertInstallation({
      installationId: 900,
      tenantId: tenant.id,
      accountLogin: 'capacity',
      accountType: 'Organization',
    });
    db.upsertRepo({
      installationId: 900,
      tenantId: tenant.id,
      githubRepoId: 901,
      owner: 'capacity',
      name: 'review-target',
      fullName: 'capacity/review-target',
      enabled: true,
    });

    const providerAdmission = new MemoryProviderAdmission({ retryDelayMs: 1, waitMs: 5_000 });
    const queue = new MemoryReviewQueue({ providerAdmission });
    for (let pr = 1; pr <= REVIEW_COUNT; pr++) {
      const result = await queue.enqueue(reviewJob(tenant.id, pr));
      assert.equal(result.accepted, true);
    }

    const reviews = new PeakCounter();
    const providers = new Map<string, PeakCounter>();
    const sandboxes = new ConcurrencyGate(config.sandbox.sandbox.maxConcurrentSandboxes);
    const finished = deferred<void>();
    let completed = 0;
    const originalLog = console.log;
    console.log = () => undefined;

    const stop = startWorkerLoop(queue, {
      config,
      db,
      pollMs: 1,
      recoveryMs: 60_000,
      isDraining: () => false,
      canAdmitHost: () => true,
      loadConfig: () => ({ store: db }) as WorkerConfig,
      processReview: async (job, workerConfig): Promise<ProcessResult> => {
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
        await workerConfig.persistJob?.(job);
        reviews.enter();
        try {
          const plan = compileReviewPlan('multi-model');
          assert.ok(plan, 'the high-tier plan must remain available');
          await runBoundedStages(plan.discovery, config.review.execution.concurrency, (stage) =>
            runSyntheticStage(stage, config, providerAdmission, providers, sandboxes),
          );
          await runSyntheticStage(
            plan.verification,
            config,
            providerAdmission,
            providers,
            sandboxes,
          );
          db.completeReviewRun(runId, { status: 'completed', durationMs: 1 });
          completed += 1;
          if (completed === REVIEW_COUNT) finished.resolve();
          return { findingCount: 0, newCount: 0, fixedCount: 0 };
        } finally {
          reviews.leave();
        }
      },
    });
    t.after(async () => {
      await stop();
      console.log = originalLog;
    });

    await finished.promise;
    await waitForQueueIdle(queue);
    assert.equal(completed, REVIEW_COUNT);
    assert.ok(reviews.peak >= 1);
    assert.ok(reviews.peak <= config.worker.concurrency);
    assert.ok((providers.get('luna')?.peak ?? 0) <= 8);
    assert.ok((providers.get('minimax')?.peak ?? 0) <= 32);
    assert.ok((providers.get('deepseek')?.peak ?? 0) <= 64);
    assert.ok(sandboxes.peak <= config.sandbox.sandbox.maxConcurrentSandboxes);
    assert.deepEqual(await queue.depth(), {
      queued: 0,
      waitingOnPr: 0,
      inFlight: 0,
      oldestQueuedAt: null,
    });
    assert.equal(
      db.listReviewRuns(tenant.id, REVIEW_COUNT).filter((run) => run.status === 'completed').length,
      REVIEW_COUNT,
    );

    await assertCanSaturate(providerAdmission, 'deepseek', 64);
    await assertCanSaturate(providerAdmission, 'luna', 8);
    await assertCanSaturate(providerAdmission, 'minimax', 32);
  },
);

async function runSyntheticStage(
  stage: ReviewStage,
  config: ReturnType<typeof testServerConfig>,
  admission: ProviderAdmission,
  providers: Map<string, PeakCounter>,
  sandboxes: ConcurrencyGate,
): Promise<void> {
  const provider = providerFor(stage);
  const token = await admission.acquireProviderLease(
    provider,
    config.review.providerConcurrency(provider),
  );
  const counter = providers.get(provider) ?? new PeakCounter();
  providers.set(provider, counter);
  counter.enter();
  try {
    const work = async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
    };
    if (provider === 'luna') await sandboxes.run(work);
    else await work();
  } finally {
    counter.leave();
    await admission.releaseProviderLease(provider, token);
  }
}

async function runBoundedStages(
  stages: readonly ReviewStage[],
  concurrency: number,
  run: (stage: ReviewStage) => Promise<void>,
): Promise<void> {
  for (let index = 0; index < stages.length; index += concurrency) {
    await Promise.all(stages.slice(index, index + concurrency).map(run));
  }
}

function providerFor(stage: ReviewStage): 'luna' | 'deepseek' | 'minimax' {
  switch (stage.modelSlot) {
    case 'luna':
      return 'luna';
    case 'deepseek-flash':
      return 'deepseek';
    case 'minimax':
      return 'minimax';
  }
}

async function assertCanSaturate(
  admission: ProviderAdmission,
  provider: 'luna' | 'deepseek' | 'minimax',
  capacity: number,
): Promise<void> {
  const counter = new PeakCounter();
  const gate = deferred<void>();
  const allAcquired = deferred<void>();
  let acquired = 0;
  const leases = Array.from({ length: capacity }, async () => {
    const token = await admission.acquireProviderLease(provider, capacity);
    counter.enter();
    acquired += 1;
    if (acquired === capacity) allAcquired.resolve();
    try {
      await gate.promise;
    } finally {
      counter.leave();
      await admission.releaseProviderLease(provider, token);
    }
  });
  await allAcquired.promise;
  assert.equal(counter.peak, capacity);
  gate.resolve();
  await Promise.all(leases);
}

function reviewJob(tenantId: string, pr: number): ReviewJobPayload {
  return {
    installationId: 900,
    tenantId,
    owner: 'capacity',
    repo: 'review-target',
    pr,
    headSha: `capacity-${pr}`,
    action: 'opened',
    enqueuedAt: '2026-08-10T00:00:00.000Z',
  };
}

class PeakCounter {
  active = 0;
  peak = 0;

  enter(): void {
    this.active += 1;
    this.peak = Math.max(this.peak, this.active);
  }

  leave(): void {
    this.active -= 1;
    assert.ok(this.active >= 0, 'concurrency counter cannot become negative');
  }
}

class ConcurrencyGate {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  peak = 0;

  constructor(private readonly capacity: number) {}

  async run(work: () => Promise<void>): Promise<void> {
    if (this.active >= this.capacity)
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active += 1;
    this.peak = Math.max(this.peak, this.active);
    try {
      await work();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function waitForQueueIdle(queue: MemoryReviewQueue, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await queue.depth()).inFlight === 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  assert.fail('worker did not finalize all queue leases before the stress-test deadline');
}
