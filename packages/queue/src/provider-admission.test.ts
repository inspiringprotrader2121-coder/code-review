import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Redis } from 'ioredis';
import { MemoryProviderAdmission, providersSaturated } from './provider-admission.js';
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

test('memory fair waiters prefer oldest and renew in-flight leases', async () => {
  const admission = new MemoryProviderAdmission({ retryDelayMs: 1, waitMs: 2_000, leaseTtlMs: 5_000 });
  const first = await admission.acquireProviderLease('deepseek', 1);
  const order: string[] = [];
  const older = admission
    .acquireProviderLease('deepseek', 1, undefined, { priorityBiasMs: -1_000 })
    .then(async (token) => {
      order.push('older');
      await admission.releaseProviderLease('deepseek', token);
    });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const newer = admission.acquireProviderLease('deepseek', 1).then(async (token) => {
    order.push('newer');
    await admission.releaseProviderLease('deepseek', token);
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(await admission.renewProviderLease('deepseek', first), true);
  await admission.releaseProviderLease('deepseek', first);
  await Promise.all([older, newer]);
  assert.deepEqual(order, ['older', 'newer']);
});

test('memory saturation retry-after reflects oldest lease expiry', async () => {
  let now = 1_000_000;
  const admission = new MemoryProviderAdmission({
    retryDelayMs: 1,
    waitMs: 1_000,
    leaseTtlMs: 12_000,
    now: () => now,
  });
  const held = await admission.acquireProviderLease('luna', 1);
  const pending = admission.acquireProviderLease('luna', 1, undefined, { waitMs: 1_000 });
  now += 1_050;
  await assert.rejects(pending, /retry-after: 11\b/);
  await admission.releaseProviderLease('luna', held);
});

test('providersSaturated is true only when every lane is full', async () => {
  const admission = new MemoryProviderAdmission({ retryDelayMs: 1 });
  const luna = await admission.acquireProviderLease('luna', 1);
  assert.equal(await providersSaturated(admission, ['luna', 'deepseek']), false);
  const deepseek = await admission.acquireProviderLease('deepseek', 1);
  assert.equal(await providersSaturated(admission, ['luna', 'deepseek']), true);
  await admission.releaseProviderLease('luna', luna);
  await admission.releaseProviderLease('deepseek', deepseek);
});

test(
  'Redis fair waiters wake oldest first with honest retry-after',
  { skip: !redisUrl },
  async (t) => {
    const namespace = `orvex-review:admission-fair:${process.pid}:${randomUUID()}`;
    const redis = new Redis(redisUrl!);
    const admission = new RedisProviderAdmission(redis, {
      namespace,
      waitMs: 2_000,
      leaseTtlMs: 960_000,
      random: () => 0,
    });
    t.after(async () => {
      let cursor = '0';
      do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', `${namespace}:*`, 'COUNT', 200);
        cursor = next;
        if (keys.length) await redis.unlink(...keys);
      } while (cursor !== '0');
      await redis.quit();
    });

    const first = await admission.acquireProviderLease('minimax', 1);
    const order: string[] = [];
    const older = admission
      .acquireProviderLease('minimax', 1, undefined, { priorityBiasMs: -5_000 })
      .then(async (token) => {
        order.push('older');
        assert.equal(await admission.renewProviderLease('minimax', token), true);
        await admission.releaseProviderLease('minimax', token);
      });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const newer = admission.acquireProviderLease('minimax', 1).then(async (token) => {
      order.push('newer');
      await admission.releaseProviderLease('minimax', token);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await admission.releaseProviderLease('minimax', first);
    await Promise.all([older, newer]);
    assert.deepEqual(order, ['older', 'newer']);

    const held = await admission.acquireProviderLease('minimax', 1);
    await assert.rejects(
      admission.acquireProviderLease('minimax', 1, undefined, { waitMs: 1_000 }),
      /distributed concurrency saturated; retry-after: [2-9]\d*/,
    );
    await admission.releaseProviderLease('minimax', held);
  },
);
