import assert from 'node:assert/strict';
import test from 'node:test';
import { Redis } from 'ioredis';
import { RedisReviewQueue } from './redis.js';
import { prKey, type ReviewJobPayload } from './types.js';

const redisUrl = process.env.REDIS_TEST_URL;

test(
  'Redis queue atomically deduplicates, coalesces, and recovers orphaned jobs',
  { skip: !redisUrl },
  async (t) => {
    const cleanup = new Redis(redisUrl!);
    await cleanup.flushdb();
    t.after(async () => {
      await cleanup.flushdb();
      await cleanup.quit();
    });

    const queue = new RedisReviewQueue(redisUrl!);
    let queueClosed = false;
    t.after(async () => {
      if (!queueClosed) await queue.close();
    });
    assert.equal(await queue.ping(), true);

    const first = job('sha-first', 41, 'opened');
    const pending = job('sha-pending', 41, 'synchronize');
    assert.equal((await queue.enqueue(first)).reason, 'enqueued');
    assert.deepEqual(await queue.dequeue(), first);

    const coalesced = await queue.enqueue(pending);
    assert.equal(coalesced.accepted, true);
    assert.equal(coalesced.reason, 'coalesced');

    await queue.markCompleted(first);
    assert.deepEqual(await queue.releaseLockAndDrain(prKey(first)), pending);
    assert.equal((await queue.enqueue(first)).reason, 'duplicate');

    const orphan = job('sha-orphan', 42, 'opened');
    await queue.markCompleted(pending);
    assert.equal((await queue.enqueue(orphan)).accepted, true);
    assert.deepEqual(await queue.dequeue(), orphan);

    await queue.close();
    queueClosed = true;
    const restarted = new RedisReviewQueue(redisUrl!);
    let restartedClosed = false;
    t.after(async () => {
      if (!restartedClosed) await restarted.close();
    });
    assert.equal(await restarted.recoverOrphans(), 1);
    assert.deepEqual(await restarted.dequeue(), orphan);
    await restarted.markFailed(orphan, 'test failure');
    assert.equal((await restarted.enqueue(orphan)).accepted, true, 'failed jobs can be retried');
    await restarted.markCompleted(orphan);
    await restarted.close();
    restartedClosed = true;
  },
);

function job(headSha: string, pr: number, action: ReviewJobPayload['action']): ReviewJobPayload {
  return {
    installationId: 7,
    tenantId: 'tenant-test',
    owner: 'orvex-test',
    repo: 'queue-test',
    pr,
    headSha,
    action,
    enqueuedAt: `2026-08-05T18:00:${String(pr).padStart(2, '0')}.000Z`,
  };
}
