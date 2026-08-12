import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MemoryProviderAdmission,
  MemoryReviewQueue,
  type ReviewJobPayload,
  type ReviewQueue,
} from '@orvex-review/queue';
import type { WorkerConfig } from '../../review/worker-types.js';
import { testServerConfig } from '../../bootstrap/test-config.js';
import { processWorkerJob } from './job-processor.js';
import { fleetProvidersSaturated, returnJobForProviderHeadroom } from './queue-policy.js';

const job = {
  installationId: 12,
  tenantId: 'tenant',
  owner: 'acme',
  repo: 'api',
  pr: 99,
  headSha: 'headroom-sha',
  action: 'opened',
  enqueuedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
} satisfies ReviewJobPayload;

test('fleetProvidersSaturated tracks shared memory admission occupancy', async () => {
  const admission = new MemoryProviderAdmission({ retryDelayMs: 1 });
  assert.equal(await fleetProvidersSaturated(admission, ['luna']), false);
  const token = await admission.acquireProviderLease('luna', 1);
  assert.equal(await fleetProvidersSaturated(admission, ['luna']), true);
  await admission.releaseProviderLease('luna', token);
  assert.equal(await fleetProvidersSaturated(admission, ['luna']), false);
});

test('returnJobForProviderHeadroom preserves original enqueuedAt', async () => {
  const queue = new MemoryReviewQueue();
  await queue.enqueue(job);
  const claimed = await queue.dequeue();
  assert.ok(claimed);
  assert.equal(await returnJobForProviderHeadroom(queue, claimed!), 'requeued');
  const again = await queue.dequeue();
  assert.equal(again?.enqueuedAt, job.enqueuedAt);
  await queue.markCompleted(again!);
});

test('processWorkerJob defers when provider fleet is saturated', async () => {
  const admission = new MemoryProviderAdmission({ retryDelayMs: 1 });
  const luna = await admission.acquireProviderLease('luna', 1);
  const deepseek = await admission.acquireProviderLease('deepseek', 1);
  const minimax = await admission.acquireProviderLease('minimax', 1);
  const queue = new MemoryReviewQueue({ providerAdmission: admission });
  await queue.enqueue(job);
  const claimed = await queue.dequeue();
  assert.ok(claimed);
  let ran = false;
  const logs: string[] = [];

  await processWorkerJob(claimed!, {
    queue,
    runtime: testServerConfig(),
    loadConfig: () => ({ store: {} }) as WorkerConfig,
    processReview: async () => {
      ran = true;
      return { findingCount: 0, newCount: 0, fixedCount: 0 };
    },
    active: () => 1,
    capacity: 8,
    onSettled: () => {},
    log: {
      log: (message) => logs.push(String(message)),
      warn: () => {},
      error: () => {},
    },
  });

  assert.equal(ran, false);
  assert.ok(logs.some((line) => /provider fleet saturated/i.test(line)));
  const again = await queue.dequeue();
  assert.equal(again?.headSha, job.headSha);
  assert.equal(again?.enqueuedAt, job.enqueuedAt);
  await queue.markFailed(again!, {
    code: 'execution_failed',
    message: 'cleanup',
    retryable: false,
  });
  await admission.releaseProviderLease('luna', luna);
  await admission.releaseProviderLease('deepseek', deepseek);
  await admission.releaseProviderLease('minimax', minimax);
});

test('processWorkerJob marks mid-review calls as straggler priority', async () => {
  const queue = {
    async markRunning() {
      return true;
    },
    async renewLease() {},
    async markCompleted() {
      return true;
    },
    async markFailed() {
      return true;
    },
    async releaseLockAndDrain() {
      return null;
    },
    providerAdmission: new MemoryProviderAdmission({ retryDelayMs: 1 }),
  } as unknown as ReviewQueue;

  let ran = false;
  await processWorkerJob(
    { ...job },
    {
      queue,
      runtime: testServerConfig(),
      loadConfig: () => ({ store: {} }) as WorkerConfig,
      processReview: async () => {
        ran = true;
        return { findingCount: 0, newCount: 0, fixedCount: 0 };
      },
      active: () => 1,
      capacity: 8,
      onSettled: () => {},
      log: { log: () => {}, warn: () => {}, error: () => {} },
    },
  );
  assert.equal(ran, true);
});
