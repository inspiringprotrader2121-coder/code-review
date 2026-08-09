import assert from 'node:assert/strict';
import test from 'node:test';
import {
  failInterruptedJobs,
  finalizeQueueJob,
  returnLateDequeuedJob,
  resolveMaxJobRetries,
  resolveWorkerConcurrency,
  recoverOrphansAsLeader,
  shouldReturnDequeuedJob,
  startWorkerLoop,
  waitForReservedDequeues,
} from './queue-runner.js';
import {
  MemoryReviewQueue,
  type QueueFailure,
  type ReviewJobPayload,
  type ReviewQueue,
} from '@orvex-review/queue';
import { activeReviewSignal } from './active-reviews.js';
import { AppDatabase } from '@orvex-review/store';
import type { WorkerConfig } from './pipeline.js';
import { testServerConfig } from './bootstrap/test-config.js';

test('worker concurrency remains an explicit operator ceiling', () => {
  assert.equal(resolveWorkerConcurrency(testServerConfig({})), 8);
  assert.equal(
    resolveWorkerConcurrency(testServerConfig({ ORVEX_MAX_CONCURRENT_REVIEWS: '4' })),
    4,
  );
  assert.equal(
    resolveWorkerConcurrency(
      testServerConfig({
        ORVEX_MAX_CONCURRENT_REVIEWS: '4',
        ORVEX_CODEX_CLI: '1',
      }),
    ),
    4,
  );
  assert.equal(
    resolveWorkerConcurrency(
      testServerConfig({
        ORVEX_MAX_CONCURRENT_REVIEWS: '4',
        ORVEX_CODEX_CLI: '1',
        ORVEX_CODEX_APIKEY_CONCURRENCY: '8',
      }),
    ),
    4,
  );
});

test('full failed reviews are not automatically replayed unless explicitly enabled', () => {
  assert.equal(resolveMaxJobRetries(testServerConfig({})), 0);
  assert.equal(resolveMaxJobRetries(testServerConfig({ ORVEX_MAX_JOB_RETRIES: '1' })), 1);
  assert.equal(resolveMaxJobRetries(testServerConfig({ ORVEX_MAX_JOB_RETRIES: '20' })), 1);
  assert.equal(resolveMaxJobRetries(testServerConfig({ ORVEX_MAX_JOB_RETRIES: 'invalid' })), 0);
});

test('a drain arriving during dequeue returns the untouched claim', () => {
  assert.equal(shouldReturnDequeuedJob(true, false), false);
  assert.equal(shouldReturnDequeuedJob(false, false), true);
  assert.equal(shouldReturnDequeuedJob(true, true), true);
});

test('periodic recovery runs under one distributed recovery lease', async () => {
  let recoveries = 0;
  const released: string[] = [];
  const follower = {
    async recoverOrphans() {
      recoveries += 1;
      return 0;
    },
    async acquireRecoveryLease() {
      return null;
    },
  };
  assert.equal(await recoverOrphansAsLeader(follower), null);
  assert.equal(recoveries, 0);

  const leader = {
    async recoverOrphans() {
      recoveries += 1;
      return 0;
    },
    async acquireRecoveryLease() {
      return 'leader-token';
    },
    async releaseRecoveryLease() {
      released.push('leader-token');
    },
  };
  assert.equal(await recoverOrphansAsLeader(leader), 0);
  assert.equal(recoveries, 1);
  assert.deepEqual(released, ['leader-token']);
});

test('memory-style queues retain direct periodic recovery', async () => {
  let recoveries = 0;
  assert.equal(
    await recoverOrphansAsLeader({
      async recoverOrphans() {
        recoveries += 1;
        return 0;
      },
    }),
    0,
  );
  assert.equal(recoveries, 1);
});

test('restart interruption is failed without re-enqueuing paid stages', async () => {
  const marked: string[] = [];
  const interrupted: string[] = [];
  const job = {
    installationId: 1,
    tenantId: 'tenant',
    owner: 'owner',
    repo: 'repo',
    pr: 7,
    headSha: 'abc',
    action: 'opened',
    enqueuedAt: new Date(0).toISOString(),
    runId: 'run-1',
  } satisfies ReviewJobPayload;

  const count = await failInterruptedJobs(
    {
      async markFailed(_job, failure) {
        marked.push(`${failure.code}:${failure.message}`);
      },
    },
    {
      interruptReviewRun(runId) {
        interrupted.push(runId);
      },
    },
    [job],
  );

  assert.equal(count, 1);
  assert.deepEqual(interrupted, ['run-1']);
  assert.deepEqual(marked, ['worker_restart:interrupted by restart']);
});

test('shutdown bounds its wait for a dequeue that never settles', { timeout: 5_000 }, async () => {
  const started = Date.now();
  const settled = await waitForReservedDequeues(
    () => 1,
    () => 0,
    30,
    5,
  );
  const elapsed = Date.now() - started;

  assert.equal(settled, false);
  assert.ok(elapsed >= 20, `returned too early after ${elapsed}ms`);
  assert.ok(elapsed < 4_000, `shutdown handoff wait was not bounded (${elapsed}ms)`);
});

test('forced shutdown aborts an active API review before durable cleanup', async () => {
  const queue = new MemoryReviewQueue();
  const queued = {
    installationId: 1,
    tenantId: 'tenant',
    owner: 'owner',
    repo: 'repo',
    pr: 99,
    headSha: 'shutdown-sha',
    action: 'opened',
    enqueuedAt: new Date(0).toISOString(),
  } satisfies ReviewJobPayload;
  await queue.enqueue(queued);
  let observedSignal: AbortSignal | undefined;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });

  const stop = startWorkerLoop(queue, {
    config: testServerConfig(),
    db: new AppDatabase(':memory:'),
    maxConcurrent: 1,
    pollMs: 1,
    isDraining: () => false,
    shutdownDrainMs: 1,
    shutdownCancelMs: 250,
    loadConfig: () => ({ store: {} }) as unknown as WorkerConfig,
    processReview: async () => {
      observedSignal = activeReviewSignal();
      assert.ok(observedSignal);
      entered();
      await new Promise<void>((_resolve, reject) => {
        observedSignal!.addEventListener(
          'abort',
          () => reject(new Error(String(observedSignal!.reason ?? 'worker_shutdown'))),
          { once: true },
        );
      });
      throw new Error('unreachable');
    },
  });

  await started;
  await stop();
  assert.equal(observedSignal?.aborted, true);
  assert.equal((await queue.depth()).inFlight, 0);
});

test('a late dequeue drains a newer coalesced SHA instead of requeueing the old one', async () => {
  const calls: string[] = [];
  const newer = {
    installationId: 1,
    tenantId: 'tenant',
    owner: 'owner',
    repo: 'repo',
    pr: 7,
    headSha: 'newer',
    action: 'synchronize',
    enqueuedAt: new Date(1).toISOString(),
  } satisfies ReviewJobPayload;
  const old = { ...newer, headSha: 'old', enqueuedAt: new Date(0).toISOString() };
  const queue = {
    async markFailed() {
      calls.push('failed-old');
    },
    async releaseLockAndDrain() {
      calls.push('drained-newer');
      return newer;
    },
    async enqueue() {
      calls.push('requeued-old');
      return { accepted: true, jobId: 'old', reason: 'enqueued' as const };
    },
  };

  assert.equal(await returnLateDequeuedJob(queue, old), 'newer-pending');
  assert.deepEqual(calls, ['failed-old', 'drained-newer']);
});

test('close-aborted reviews clear queue dedup instead of being marked completed', async () => {
  const calls: string[] = [];
  const queue = {
    markCompleted: async () => {
      calls.push('completed');
    },
    markFailed: async (_job: ReviewJobPayload, failure: QueueFailure) => {
      calls.push(`failed:${failure.code}:${failure.message}`);
    },
  } as Pick<ReviewQueue, 'markCompleted' | 'markFailed'>;
  const job = {
    installationId: 1,
    tenantId: 't',
    owner: 'acme',
    repo: 'api',
    pr: 1,
    headSha: 'abc',
    action: 'opened',
    enqueuedAt: new Date().toISOString(),
  } satisfies ReviewJobPayload;

  await finalizeQueueJob(queue, job, { draftSkipped: false, prClosedMidRun: true });
  assert.deepEqual(calls, ['failed:pr_closed:pr_closed_mid_run']);
});
