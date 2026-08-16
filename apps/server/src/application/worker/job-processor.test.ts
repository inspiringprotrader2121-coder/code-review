import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryReviewQueue, type ReviewJobPayload, type ReviewQueue } from '@orvex-review/queue';
import type { WorkerConfig } from '../../review/worker-types.js';
import { testServerConfig } from '../../bootstrap/test-config.js';
import { processWorkerJob } from './job-processor.js';

const job = {
  installationId: 12,
  tenantId: 'tenant',
  owner: 'acme',
  repo: 'api',
  pr: 42,
  headSha: 'persisted-sha',
  action: 'opened',
  enqueuedAt: new Date(0).toISOString(),
} satisfies ReviewJobPayload;

test('successful persisted work is completed after transient lease noise, not discarded', async () => {
  const events: string[] = [];
  let renewals = 0;
  const queue = {
    async markRunning() {
      events.push('running');
      return true;
    },
    async renewLease() {
      renewals++;
      throw new Error('redis connection reset');
    },
    async persistJob(persisted: ReviewJobPayload) {
      events.push(`persist:${persisted.runId}`);
    },
    async markCompleted() {
      events.push('completed');
      return true;
    },
    async markFailed() {
      events.push('failed');
      return true;
    },
    async releaseLockAndDrain() {
      events.push('drain');
      return null;
    },
  } as unknown as ReviewQueue;

  await processWorkerJob(
    { ...job },
    {
      queue,
      runtime: testServerConfig(),
      loadConfig: () => ({ store: {} }) as WorkerConfig,
      processReview: async (running, config) => {
        running.runId = 'durable-run';
        await config.persistJob?.(running);
        return { findingCount: 0, newCount: 0, fixedCount: 0 };
      },
      active: () => 1,
      capacity: 8,
      onSettled: () => events.push('settled'),
      log: { log: () => {}, warn: () => {}, error: () => {} },
    },
  );

  assert.equal(renewals, 2, 'final live ownership check is bounded to one retry');
  assert.deepEqual(events, ['running', 'persist:durable-run', 'completed', 'settled', 'drain']);
});

test('Luna TPM 429s requeue even when whole-review retries are disabled', async () => {
  const queue = new MemoryReviewQueue();
  await queue.enqueue(job);
  const claimed = await queue.dequeue();
  assert.ok(claimed);

  await processWorkerJob(claimed!, {
    queue,
    runtime: testServerConfig({ ORVEX_MAX_JOB_RETRIES: '0' }),
    loadConfig: () => ({ store: {} }) as WorkerConfig,
    processReview: async () => {
      throw new Error(
        'review aborted: review incomplete: 1/3 required review coverage unit(s) did not complete because provider admission was saturated while waiting for capacity; requeueing instead of publishing an incomplete review',
      );
    },
    active: () => 1,
    capacity: 8,
    onSettled: () => {},
    log: { log: () => {}, warn: () => {}, error: () => {} },
  });

  assert.deepEqual(await queue.listDeadLetters!(), []);
  const again = await queue.dequeue();
  assert.equal(again?.headSha, job.headSha);
  assert.equal(again?.attempts, 1);
  assert.equal(again?.enqueuedAt, job.enqueuedAt);
  await queue.markCompleted(again!);
});

test('incomplete reviews after paid work are not whole-job retried', async () => {
  const queue = new MemoryReviewQueue();
  await queue.enqueue(job);
  const claimed = await queue.dequeue();
  assert.ok(claimed);

  await processWorkerJob(claimed!, {
    queue,
    runtime: testServerConfig({ ORVEX_MAX_JOB_RETRIES: '1' }),
    loadConfig: () => ({ store: {} }) as WorkerConfig,
    processReview: async () => {
      throw new Error(
        'review aborted: review incomplete: 1/3 required review coverage unit(s) did not complete because a provider timed out or was temporarily unavailable; refusing to publish an incomplete review',
      );
    },
    active: () => 1,
    capacity: 8,
    onSettled: () => {},
    log: { log: () => {}, warn: () => {}, error: () => {} },
  });

  const [record] = await queue.listDeadLetters!();
  assert.ok(record);
  assert.equal(record.reason, 'execution_failed');
  assert.equal(await queue.dequeue(), null);
});

test('MiniMax and DeepSeek capacity misses requeue the same way as Luna', async () => {
  for (const message of [
    '429 rate-limited on every minimax key (1); retry-after: 20; Token Plan usage limit reached (2056)',
    '429 DeepSeek TPM 2000000/min exhausted across 3 account(s); retry-after: 60',
  ]) {
    const queue = new MemoryReviewQueue();
    await queue.enqueue(job);
    const claimed = await queue.dequeue();
    assert.ok(claimed);
    await processWorkerJob(claimed!, {
      queue,
      runtime: testServerConfig({ ORVEX_MAX_JOB_RETRIES: '0' }),
      loadConfig: () => ({ store: {} }) as WorkerConfig,
      processReview: async () => {
        throw new Error(
          `review aborted: review incomplete: 1/3 required review coverage unit(s) did not complete because ${message}; requeueing instead of publishing an incomplete review`,
        );
      },
      active: () => 1,
      capacity: 8,
      onSettled: () => {},
      log: { log: () => {}, warn: () => {}, error: () => {} },
    });
    assert.equal((await queue.listDeadLetters!()).length, 0, message);
    const again = await queue.dequeue();
    assert.equal(again?.attempts, 1, message);
    await queue.markCompleted(again!);
  }
});

test('exhausted work is dead-lettered and produces an operator alert', async () => {
  const queue = new MemoryReviewQueue();
  await queue.enqueue(job);
  const claimed = await queue.dequeue();
  assert.ok(claimed);
  const alerts: string[] = [];

  await processWorkerJob(claimed!, {
    queue,
    runtime: testServerConfig({
      ORVEX_MAX_JOB_RETRIES: '0',
      ORVEX_ALERT_WEBHOOK_URL: 'https://alerts.invalid/worker',
    }),
    loadConfig: () => ({ store: {} }) as WorkerConfig,
    processReview: async (_job, config) => {
      assert.equal(config.providerAdmission, queue.providerAdmission);
      throw new Error('provider response failed permanently');
    },
    active: () => 1,
    capacity: 8,
    onSettled: () => {},
    alert: async (input) => {
      alerts.push(`${input.event}:${input.severity}:${input.message}`);
      return true;
    },
    log: { log: () => {}, warn: () => {}, error: () => {} },
  });

  const [record] = await queue.listDeadLetters!();
  assert.ok(record);
  assert.equal(record.reason, 'execution_failed');
  assert.equal(alerts.length, 1);
  assert.match(alerts[0]!, /^queue-dead-lettered:.*:critical:/);
  assert.equal((await queue.depth()).inFlight, 0);
});
