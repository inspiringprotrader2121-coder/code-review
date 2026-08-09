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
