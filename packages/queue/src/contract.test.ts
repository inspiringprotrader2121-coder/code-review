import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Redis } from 'ioredis';
import { assertReviewQueueContract } from './contract.js';
import { MemoryReviewQueue } from './memory.js';
import { RedisReviewQueue } from './redis.js';

test('memory queue satisfies the shared black-box contract', async () => {
  const queue = new MemoryReviewQueue();
  await assertReviewQueueContract(queue);
  await queue.close();
});

const redisUrl = process.env.REDIS_TEST_URL;
test('Redis queue satisfies the shared black-box contract', { skip: !redisUrl }, async (t) => {
  const namespace = `orvex-review:contract:${process.pid}:${randomUUID()}`;
  const queue = new RedisReviewQueue(redisUrl!, { namespace });
  const cleanup = new Redis(redisUrl!);
  t.after(async () => {
    await queue.close();
    let cursor = '0';
    do {
      const [next, keys] = await cleanup.scan(cursor, 'MATCH', `${namespace}:*`, 'COUNT', 200);
      cursor = next;
      if (keys.length > 0) await cleanup.unlink(...keys);
    } while (cursor !== '0');
    await cleanup.quit();
  });
  await assertReviewQueueContract(queue);
});
