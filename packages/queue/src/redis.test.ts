import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { Redis } from 'ioredis';
import { RedisReviewQueue } from './redis.js';
import { jobIdempotencyKey, prKey, type ReviewJobPayload } from './types.js';

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
    const claimedFirst = await queue.dequeue();
    assert.deepEqual(claimedFirst, first);

    const coalesced = await queue.enqueue(pending);
    assert.equal(coalesced.accepted, true);
    assert.equal(coalesced.reason, 'coalesced');

    await queue.markCompleted(claimedFirst!);
    assert.deepEqual(await queue.releaseLockAndDrain(prKey(first)), pending);
    assert.equal((await queue.enqueue(first)).reason, 'duplicate');

    const orphan = job('sha-orphan', 42, 'opened');
    assert.equal((await queue.enqueue(orphan)).accepted, true);
    const claimedPending = await queue.dequeue();
    assert.deepEqual(claimedPending, pending);
    await queue.markCompleted(claimedPending!);
    assert.equal(await queue.releaseLockAndDrain(prKey(pending)), null);
    const claimedOrphan = await queue.dequeue();
    assert.deepEqual(claimedOrphan, orphan);
    const [orphanEntry] = await cleanup.lrange('orvex-review:processing', 0, -1);
    assert.ok(orphanEntry);

    await queue.close();
    queueClosed = true;
    await cleanup.del(`orvex-review:inflight:${prKey(orphan)}`);
    await cleanup.set(
      `orvex-review:processing-meta:${createHash('sha256').update(orphanEntry!).digest('hex')}`,
      String(Date.now() - 60_000),
    );
    const restarted = new RedisReviewQueue(redisUrl!);
    let restartedClosed = false;
    t.after(async () => {
      if (!restartedClosed) await restarted.close();
    });
    assert.equal(await restarted.recoverOrphans(), 1);
    const recoveredOrphan = await restarted.dequeue();
    assert.deepEqual(recoveredOrphan, orphan);
    await restarted.markFailed(recoveredOrphan!, 'test failure');
    assert.equal((await restarted.enqueue(orphan)).accepted, true, 'failed jobs can be retried');
    const retriedOrphan = await restarted.dequeue();
    assert.deepEqual(retriedOrphan, orphan);
    await restarted.markCompleted(retriedOrphan!);
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

    const [persistedEntry] = await cleanup.lrange('orvex-review:processing', 0, -1);
    assert.ok(persistedEntry);
    // Age past PROCESSING_RECOVERY_GRACE_MS and drop the live lease so recovery
    // requeues the persisted payload (including runId).
    await cleanup.set(
      `orvex-review:processing-meta:${createHash('sha256').update(persistedEntry!).digest('hex')}`,
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
    await assert.rejects(
      queue.renewLease!(dequeued!),
      /lease lost.*claim token missing/i,
    );
  },
);

test(
  'a stale worker cannot clear a newer claim processing record or dedup marker',
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

    const payload = job('sha-stale-finalizer', 78, 'opened');
    assert.equal((await queue.enqueue(payload)).accepted, true);
    const stale = await queue.dequeue();
    assert.ok(stale);
    const raw = JSON.stringify(stale);
    const lockKey = `orvex-review:inflight:${prKey(stale!)}`;
    const seenKey = `orvex-review:seen:${jobIdempotencyKey(stale!)}`;
    const [staleEntry] = await cleanup.lrange('orvex-review:processing', 0, -1);
    assert.ok(staleEntry);
    const currentEntry = `new-owner-token\n${raw}`;

    // Simulate lease expiry followed by another worker claiming this same
    // durable payload. The old worker still holds its prior token locally, but
    // PROCESSING now belongs to the newer immutable claim.
    await cleanup.set(lockKey, `new-owner-token\n${raw}`, 'EX', 900);
    await cleanup.lset('orvex-review:processing', 0, currentEntry);
    await assert.rejects(
      queue.markCompleted(stale!),
      /lease lost before completion/,
    );

    assert.match((await cleanup.get(lockKey)) ?? '', /^new-owner-token\n/);
    assert.deepEqual(await cleanup.lrange('orvex-review:processing', 0, -1), [currentEntry]);
    assert.equal(await cleanup.exists(seenKey), 1);
    assert.equal(
      await cleanup.exists(`orvex-review:done:${jobIdempotencyKey(stale!)}`),
      0,
      'stale completion cannot write a DONE marker before ownership CAS',
    );
  },
);

test(
  'provider leases and cooldowns coordinate across worker processes',
  { skip: !redisUrl },
  async (t) => {
    const cleanup = new Redis(redisUrl!);
    await cleanup.flushdb();
    const first = new RedisReviewQueue(redisUrl!);
    const second = new RedisReviewQueue(redisUrl!);
    t.after(async () => {
      await first.close();
      await second.close();
      await cleanup.flushdb();
      await cleanup.quit();
    });

    const firstToken = await first.acquireProviderLease('luna', 1);
    let secondAcquired = false;
    const pending = second.acquireProviderLease('luna', 1).then((token) => {
      secondAcquired = true;
      return token;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(secondAcquired, false, 'second worker waits behind distributed Luna limit');
    await first.releaseProviderLease('luna', firstToken);
    const secondToken = await pending;
    await second.releaseProviderLease('luna', secondToken);

    await first.setProviderCooldown('deepseek', 1_000);
    assert.ok(await second.getProviderCooldownMs('deepseek') > 0, 'cooldown is visible to peer worker');
  },
);

test(
  'hundreds of simultaneous reviews drain exactly once across Redis workers',
  { skip: !redisUrl },
  async (t) => {
    const cleanup = new Redis(redisUrl!);
    await cleanup.flushdb();
    const workers = Array.from({ length: 8 }, () => new RedisReviewQueue(redisUrl!));
    t.after(async () => {
      await Promise.all(workers.map((worker) => worker.close()));
      await cleanup.flushdb();
      await cleanup.quit();
    });

    const jobs = Array.from({ length: 200 }, (_, index) => ({
      ...job(`sha-load-${index}`, 1_000 + index, 'opened' as const),
      enqueuedAt: new Date(Date.UTC(2026, 7, 5, 18, 0, index)).toISOString(),
    }));
    const accepted = await Promise.all(
      jobs.map((payload, index) => workers[index % workers.length]!.enqueue(payload)),
    );
    assert.equal(accepted.filter((result) => result.reason === 'enqueued').length, jobs.length);
    assert.equal((await workers[0]!.depth!()).queued, jobs.length);

    const duplicates = await Promise.all(
      jobs.map((payload, index) => workers[index % workers.length]!.enqueue(payload)),
    );
    assert.equal(duplicates.filter((result) => result.reason === 'duplicate').length, jobs.length);

    const completed = new Set<string>();
    await Promise.all(
      workers.map(async (worker) => {
        while (true) {
          const claimed = await worker.dequeue();
          if (!claimed) return;
          const key = jobIdempotencyKey(claimed);
          assert.equal(completed.has(key), false, `duplicate claim for ${key}`);
          completed.add(key);
          await worker.markCompleted(claimed);
          assert.equal(await worker.releaseLockAndDrain(prKey(claimed)), null);
        }
      }),
    );

    assert.equal(completed.size, jobs.length);
    const depth = await workers[0]!.depth!();
    assert.equal(depth.queued, 0);
    assert.equal(depth.waitingOnPr, 0);
    assert.equal(depth.inFlight, 0);
  },
);

test(
  'distributed provider leases cap a burst across many workers',
  { skip: !redisUrl },
  async (t) => {
    const cleanup = new Redis(redisUrl!);
    await cleanup.flushdb();
    const workers = Array.from({ length: 6 }, () => new RedisReviewQueue(redisUrl!));
    t.after(async () => {
      await Promise.all(workers.map((worker) => worker.close()));
      await cleanup.flushdb();
      await cleanup.quit();
    });

    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 48 }, async (_, index) => {
        const worker = workers[index % workers.length]!;
        const token = await worker.acquireProviderLease('deepseek', 2);
        active += 1;
        peak = Math.max(peak, active);
        try {
          await new Promise((resolve) => setTimeout(resolve, 5));
        } finally {
          active -= 1;
          await worker.releaseProviderLease('deepseek', token);
        }
      }),
    );

    assert.equal(peak, 2);
    assert.equal(active, 0);
  },
);

test(
  'a stale worker cannot resurrect its obsolete SHA after a newer owner finishes',
  { skip: !redisUrl },
  async (t) => {
    const cleanup = new Redis(redisUrl!);
    await cleanup.flushdb();
    const staleWorker = new RedisReviewQueue(redisUrl!);
    const currentWorker = new RedisReviewQueue(redisUrl!);
    t.after(async () => {
      await Promise.all([staleWorker.close(), currentWorker.close()]);
      await cleanup.flushdb();
      await cleanup.quit();
    });

    const stale = job('sha-stale-owner', 1_900, 'opened');
    assert.equal((await staleWorker.enqueue(stale)).accepted, true);
    const staleClaim = await staleWorker.dequeue();
    assert.ok(staleClaim);

    await cleanup.del(`orvex-review:inflight:${prKey(stale)}`);
    const current = job('sha-current-owner', stale.pr, 'synchronize');
    assert.equal((await currentWorker.enqueue(current)).accepted, true);
    const currentClaim = await currentWorker.dequeue();
    assert.deepEqual(currentClaim, current);

    await staleWorker.markFailed(staleClaim!, 'lease lost');
    await currentWorker.markCompleted(currentClaim!);
    assert.equal(await currentWorker.releaseLockAndDrain(prKey(current)), null);

    assert.equal(await currentWorker.recoverOrphans(), 0);
    assert.equal(await currentWorker.dequeue(), null, 'the stale SHA was retired, not requeued');
  },
);

test(
  'two workers atomically recover an orphan exactly once',
  { skip: !redisUrl },
  async (t) => {
    const cleanup = new Redis(redisUrl!);
    await cleanup.flushdb();
    const owner = new RedisReviewQueue(redisUrl!);
    const payload = job('sha-recovery-race', 81, 'opened');
    await owner.enqueue(payload);
    const claimed = await owner.dequeue();
    assert.ok(claimed);
    const [processingEntry] = await cleanup.lrange('orvex-review:processing', 0, -1);
    assert.ok(processingEntry);
    await owner.close();
    await cleanup.del(`orvex-review:inflight:${prKey(claimed!)}`);
    await cleanup.set(
      `orvex-review:processing-meta:${createHash('sha256').update(processingEntry!).digest('hex')}`,
      String(Date.now() - 60_000),
    );

    const a = new RedisReviewQueue(redisUrl!);
    const b = new RedisReviewQueue(redisUrl!);
    t.after(async () => {
      await a.close();
      await b.close();
      await cleanup.flushdb();
      await cleanup.quit();
    });
    const recovered = await Promise.all([a.recoverOrphans(), b.recoverOrphans()]);
    assert.equal(recovered[0]! + recovered[1]!, 1);
    assert.equal(await cleanup.llen('orvex-review:jobs'), 1);
    assert.equal(await cleanup.llen('orvex-review:processing'), 0);
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
