import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
    await cleanup.del(`orvex-review:inflight:${prKey(orphan)}`);
    await cleanup.del(
      `orvex-review:processing-meta:${createHash('sha256').update(JSON.stringify(orphan)).digest('hex')}`,
    );
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

test(
  'Redis persistJob writes runId into PROCESSING so orphan recovery keeps it',
  { skip: !redisUrl },
  async (t) => {
    const cleanup = new Redis(redisUrl!);
    await cleanup.flushdb();
    t.after(async () => {
      await cleanup.flushdb();
      await cleanup.quit();
    });

    const queue = new RedisReviewQueue(redisUrl!);
    t.after(async () => {
      await queue.close();
    });

    const payload = job('sha-persist', 99, 'opened');
    assert.equal((await queue.enqueue(payload)).accepted, true);
    const dequeued = await queue.dequeue();
    assert.ok(dequeued);
    dequeued!.runId = 'run-after-reserve';
    await queue.persistJob!(dequeued!);

    const persistedRaw = JSON.stringify(dequeued);
    // Age past PROCESSING_RECOVERY_GRACE_MS and drop the live lease so recovery
    // requeues the persisted payload (including runId).
    await cleanup.set(
      `orvex-review:processing-meta:${createHash('sha256').update(persistedRaw).digest('hex')}`,
      String(Date.now() - 60_000),
    );
    await cleanup.del(`orvex-review:inflight:${prKey(dequeued!)}`);

    const recovered = new RedisReviewQueue(redisUrl!);
    t.after(async () => {
      await recovered.close();
    });
    assert.equal(await recovered.recoverOrphans(), 1);
    const again = await recovered.dequeue();
    assert.equal(again?.runId, 'run-after-reserve');
    await recovered.markFailed(again!, 'done');
  },
);

test(
  'Redis renewLease still succeeds after persistJob rewrites the job payload',
  { skip: !redisUrl },
  async (t) => {
    const cleanup = new Redis(redisUrl!);
    await cleanup.flushdb();
    t.after(async () => {
      await cleanup.flushdb();
      await cleanup.quit();
    });

    const queue = new RedisReviewQueue(redisUrl!);
    t.after(async () => {
      await queue.close();
    });

    const payload = job('sha-renew', 77, 'opened');
    assert.equal((await queue.enqueue(payload)).accepted, true);
    const dequeued = await queue.dequeue();
    assert.ok(dequeued);
    dequeued!.runId = 'run-renew-check';
    await queue.persistJob!(dequeued!);
    // Regression: comparing the full token\\nraw claim made renew fail here and
    // discarded expensive reviews at publication.
    await queue.renewLease!(dequeued!);
    await queue.markCompleted(dequeued!);
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
