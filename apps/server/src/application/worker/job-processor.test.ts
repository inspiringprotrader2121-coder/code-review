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
    processReview: async () => {
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
