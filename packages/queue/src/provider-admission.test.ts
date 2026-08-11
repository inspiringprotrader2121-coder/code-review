import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Redis } from 'ioredis';
import { MemoryProviderAdmission } from './provider-admission.js';
import { assertProviderAdmissionContract } from './provider-admission-contract.js';
import { RedisProviderAdmission } from './redis-provider-admission.js';

test('memory provider admission satisfies the shared black-box contract', async () => {
  await assertProviderAdmissionContract(new MemoryProviderAdmission({ retryDelayMs: 1 }));
});

const redisUrl = process.env.REDIS_TEST_URL;
test(
  'Redis provider admission satisfies the shared black-box contract',
  { skip: !redisUrl },
  async (t) => {
    const namespace = `orvex-review:admission-contract:${process.pid}:${randomUUID()}`;
    const redis = new Redis(redisUrl!);
    const admission = new RedisProviderAdmission(redis, { namespace, random: () => 0 });
    t.after(async () => {
      let cursor = '0';
      do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', `${namespace}:*`, 'COUNT', 200);
        cursor = next;
        if (keys.length) await redis.unlink(...keys);
      } while (cursor !== '0');
      await redis.quit();
    });
    await assertProviderAdmissionContract(admission);
  },
);

test(
  'Redis provider capacity is scheduler-initialized and rejects mismatched workers',
  { skip: !redisUrl },
  async (t) => {
    const namespace = `orvex-review:admission-capacity:${process.pid}:${randomUUID()}`;
    const redis = new Redis(redisUrl!);
    t.after(async () => {
      let cursor = '0';
      do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', `${namespace}:*`, 'COUNT', 200);
        cursor = next;
        if (keys.length) await redis.unlink(...keys);
      } while (cursor !== '0');
      await redis.quit();
    });

    const scheduler = new RedisProviderAdmission(redis, {
      namespace,
      capacityPlan: {
        epoch: 'fleet-v1',
        limits: { luna: 1, deepseek: 2, minimax: 2 },
        tenantConcurrency: 2,
      },
      random: () => 0,
    });
    await scheduler.initializeProviderCapacities();

    const worker = new RedisProviderAdmission(redis, {
      namespace,
      capacityPlan: {
        epoch: 'fleet-v1',
        limits: { luna: 1, deepseek: 2, minimax: 2 },
        tenantConcurrency: 2,
      },
      random: () => 0,
    });
    await worker.assertProviderCapacitiesReady();

    const mismatchedWorker = new RedisProviderAdmission(redis, {
      namespace,
      capacityPlan: {
        epoch: 'fleet-v1',
        limits: { luna: 2, deepseek: 2, minimax: 2 },
        tenantConcurrency: 2,
      },
      random: () => 0,
    });
    await assert.rejects(
      mismatchedWorker.assertProviderCapacitiesReady(),
      /provider luna fleet capacity mismatch/i,
    );

    const first = await worker.acquireProviderLease('luna', 99);
    const abort = new AbortController();
    const second = worker.acquireProviderLease('luna', 99, abort.signal);
    abort.abort();
    await assert.rejects(second, /cancelled while waiting for provider lease/);
    await worker.releaseProviderLease('luna', first);
  },
);
