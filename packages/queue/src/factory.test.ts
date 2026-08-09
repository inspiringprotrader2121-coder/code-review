import assert from 'node:assert/strict';
import test from 'node:test';
import { createReviewQueue, loadReviewQueueConfig } from './factory.js';
import { MemoryReviewQueue } from './memory.js';
import { RedisReviewQueue } from './redis.js';

test('queue configuration preserves production Redis safety defaults', async () => {
  const config = loadReviewQueueConfig({ NODE_ENV: 'production' });
  assert.equal(config.backend, 'redis');
  assert.equal(config.redisUrl, null);
  assert.throws(() => createReviewQueue(config), /REDIS_URL is required/);
});

test('queue configuration is bounded and injectable without global environment state', async () => {
  const config = loadReviewQueueConfig({
    NODE_ENV: 'test',
    QUEUE_BACKEND: 'memory',
    ORVEX_QUEUE_NAMESPACE: 'orvex-review:test-config',
    ORVEX_MAX_RESUME_AFTER_RESTART: '999',
    ORVEX_PROVIDER_LEASE_WAIT_MS: '99999999',
    ORVEX_QUEUE_MAX_DEDUP: '5',
  });
  assert.equal(config.redisNamespace, 'orvex-review:test-config');
  assert.equal(config.maxResumeAfterRestart, 10);
  assert.equal(config.providerLeaseWaitMs, 3_600_000);
  assert.equal(config.maxMemoryDedupEntries, 5);
  const queue = createReviewQueue(config);
  assert.ok(queue instanceof MemoryReviewQueue);
  await queue.close();
});

test('queue configuration rejects unknown backends', () => {
  assert.throws(
    () => loadReviewQueueConfig({ QUEUE_BACKEND: 'filesystem' }),
    /Unsupported QUEUE_BACKEND/,
  );
});

test('Redis queue rejects unsafe namespaces before connecting', () => {
  assert.throws(
    () => new RedisReviewQueue('redis://127.0.0.1:6379', { namespace: 'unsafe namespace *' }),
    /namespace must be 1-128 safe characters/,
  );
});
