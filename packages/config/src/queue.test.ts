import assert from 'node:assert/strict';
import test from 'node:test';
import { loadQueueConfig } from './queue.js';

test('production queue configuration requires an explicit Redis URL downstream', () => {
  assert.deepEqual(loadQueueConfig({ NODE_ENV: 'production' }), {
    backend: 'redis',
    production: true,
    allowMemoryInProduction: false,
    redisUrl: null,
    redisNamespace: 'orvex-review',
    maxResumeAfterRestart: 0,
    providerLeaseWaitMs: 600_000,
    maxMemoryDedupEntries: 20_000,
  });
});

test('queue configuration bounds numeric values and rejects unknown backends', () => {
  const config = loadQueueConfig({
    QUEUE_BACKEND: 'memory',
    ORVEX_MAX_RESUME_AFTER_RESTART: '99',
    ORVEX_PROVIDER_LEASE_WAIT_MS: '-1',
    ORVEX_QUEUE_MAX_DEDUP: '5',
  });
  assert.equal(config.maxResumeAfterRestart, 10);
  assert.equal(config.providerLeaseWaitMs, 1_000);
  assert.equal(config.maxMemoryDedupEntries, 5);
  assert.throws(() => loadQueueConfig({ QUEUE_BACKEND: 'disk' }), /Unsupported QUEUE_BACKEND/);
});
