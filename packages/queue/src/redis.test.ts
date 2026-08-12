import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { Redis } from 'ioredis';
import { RedisReviewQueue } from './redis.js';
import { jobIdempotencyKey, prKey, queueFailure, type ReviewJobPayload } from './types.js';

const redisUrl = process.env.REDIS_TEST_URL;

function testNamespace(): string {
  return `orvex-review:test:${process.pid}:${randomUUID()}`;
}

async function clearNamespace(redis: Redis, namespace: string): Promise<void> {
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${namespace}:*`, 'COUNT', 200);
    cursor = next;
    if (keys.length > 0) await redis.unlink(...keys);
  } while (cursor !== '0');
}

test(
  'Redis queue atomically deduplicates, coalesces, and recovers orphaned jobs',
  { skip: !redisUrl },
  async (t) => {
    const cleanup = new Redis(redisUrl!);
    const namespace = testNamespace();
    t.after(async () => {
      await clearNamespace(cleanup, namespace);
      await cleanup.quit();
    });

    const queue = new RedisReviewQueue(redisUrl!, { namespace });
    let queueClosed = false;
    t.after(async () => {
      if (!queueClosed) await queue.close();
    });
    assert.equal(await queue.ping(), true);

    const first = job('sha-first', 41, 'opened');
    const pending = job('sha-pending', 41, 'synchronize');
    assert.equal((await queue.enqueue(first)).reason, 'enqueued');
    assert.equal(await queue.getJobState(jobIdempotencyKey(first)), 'ready');
    const claimedFirst = await queue.dequeue();
    assert.deepEqual(claimedFirst, first);
    assert.equal(await queue.getJobState(jobIdempotencyKey(first)), 'claimed');
    assert.equal(await queue.markRunning(claimedFirst!), true);
    assert.equal(await queue.getJobState(jobIdempotencyKey(first)), 'running');

    const coalesced = await queue.enqueue(pending);
    assert.equal(coalesced.accepted, true);
    assert.equal(coalesced.reason, 'coalesced');

    const superseded = job('sha-superseded', 41, 'opened');
    const latest = job('sha-latest', 41, 'synchronize');
    await queue.enqueue(superseded);
    assert.equal(await queue.getJobState(jobIdempotencyKey(superseded)), 'ready');
    await queue.enqueue(latest);
    assert.equal(
      await queue.getJobState(jobIdempotencyKey(superseded)),
      'cancelled',
      'coalescing an obsolete automatic review atomically records cancellation',
    );
    assert.equal(await queue.getJobState(jobIdempotencyKey(latest)), 'ready');

    await queue.markCompleted(claimedFirst!);
    assert.equal(await queue.getJobState(jobIdempotencyKey(first)), 'succeeded');
    assert.deepEqual(await queue.releaseLockAndDrain(prKey(first)), latest);
    assert.equal((await queue.enqueue(first)).reason, 'duplicate');

    const orphan = job('sha-orphan', 42, 'opened');
    assert.equal((await queue.enqueue(orphan)).accepted, true);
    const claimedPending = await queue.dequeue();
    assert.deepEqual(claimedPending, latest);
    await queue.markCompleted(claimedPending!);
    assert.equal(await queue.releaseLockAndDrain(prKey(latest)), null);
    const claimedOrphan = await queue.dequeue();
    assert.deepEqual(claimedOrphan, orphan);
    const [orphanEntry] = await cleanup.lrange(`${namespace}:processing`, 0, -1);
    assert.ok(orphanEntry);

    await queue.close();
    queueClosed = true;
    await cleanup.del(`${namespace}:inflight:${prKey(orphan)}`);
    await cleanup.set(
      `${namespace}:processing-meta:${createHash('sha256').update(orphanEntry!).digest('hex')}`,
      String(Date.now() - 60_000),
    );
    const restarted = new RedisReviewQueue(redisUrl!, { namespace, maxResumeAfterRestart: 2 });
    let restartedClosed = false;
    t.after(async () => {
      if (!restartedClosed) await restarted.close();
    });
    assert.equal(await restarted.recoverOrphans(), 1);
    assert.equal(await restarted.getJobState(jobIdempotencyKey(orphan)), 'ready');
    const recoveredOrphan = await restarted.dequeue();
    assert.deepEqual(recoveredOrphan, orphan);
    await restarted.markFailed(recoveredOrphan!, queueFailure('invalid_payload', 'test failure'));
    assert.equal((await restarted.enqueue(orphan)).accepted, true, 'failed jobs can be retried');
    const retriedOrphan = await restarted.dequeue();
    assert.deepEqual(retriedOrphan, orphan);
    await restarted.markCompleted(retriedOrphan!);
    await restarted.close();
    restartedClosed = true;
  },
);

test(
  'Redis fleet tenant admission gives another tenant a slot and releases it through heartbeats and completion',
  { skip: !redisUrl },
  async (t) => {
    const cleanup = new Redis(redisUrl!);
    const namespace = testNamespace();
    const plan = {
      epoch: 'tenant-fair-v1',
      limits: { luna: 2, deepseek: 2, minimax: 2 },
      tenantConcurrency: 1,
    };
    const queue = new RedisReviewQueue(redisUrl!, { namespace, providerCapacityPlan: plan });
    const scheduler =
      queue.providerAdmission as import('./redis-provider-admission.js').RedisProviderAdmission;
    t.after(async () => {
      await queue.close();
      await clearNamespace(cleanup, namespace);
      await cleanup.quit();
    });
    await scheduler.initializeProviderCapacities();

    const tenantAFirst = { ...job('tenant-a-first', 501, 'opened'), tenantId: 'tenant-a' };
    const tenantASecond = { ...job('tenant-a-second', 502, 'opened'), tenantId: 'tenant-a' };
    const tenantB = { ...job('tenant-b', 503, 'opened'), tenantId: 'tenant-b' };
    await queue.enqueue(tenantAFirst);
    await queue.enqueue(tenantASecond);
    await queue.enqueue(tenantB);

    const first = await queue.dequeue();
    assert.equal(first?.headSha, tenantAFirst.headSha);
    const second = await queue.dequeue();
    assert.equal(second?.headSha, tenantB.headSha, 'tenant B is not starved by tenant A');

    const [firstEntry] = await cleanup.lrange(`${namespace}:processing`, 0, -1);
    assert.ok(firstEntry);
    const firstToken = firstEntry!.slice(0, firstEntry!.indexOf('\n'));
    await cleanup.zadd(`${namespace}:tenant-claim-expiry`, Date.now() - 1, firstToken);
    await queue.renewLease(first!);
    assert.equal(
      await queue.dequeue(),
      null,
      'a renewed tenant-A claim still blocks its second review',
    );

    await queue.markCompleted(first!);
    assert.equal(await cleanup.hget(`${namespace}:tenant-active`, 'tenant-a'), null);
    const third = await queue.dequeue();
    assert.equal(third?.headSha, tenantASecond.headSha);
    await queue.markCompleted(second!);
    await queue.markCompleted(third!);
  },
);

test(
  'Redis fleet tenant admission bounds a mixed hundreds-of-jobs burst across many workers',
  { skip: !redisUrl, timeout: 30_000 },
  async (t) => {
    const cleanup = new Redis(redisUrl!);
    const namespace = testNamespace();
    const plan = {
      epoch: 'tenant-fair-burst-v1',
      limits: { luna: 24, deepseek: 24, minimax: 24 },
      tenantConcurrency: 2,
    };
    const workers = Array.from(
      { length: 24 },
      () => new RedisReviewQueue(redisUrl!, { namespace, providerCapacityPlan: plan }),
    );
    const scheduler = workers[0]!
      .providerAdmission as import('./redis-provider-admission.js').RedisProviderAdmission;
    t.after(async () => {
      await Promise.all(workers.map((worker) => worker.close()));
      await clearNamespace(cleanup, namespace);
      await cleanup.quit();
    });
    await scheduler.initializeProviderCapacities();

    const jobs = Array.from({ length: 360 }, (_, index) => {
      const tenant = `tenant-${String(index % 120).padStart(3, '0')}`;
      return {
        ...job(`tenant-burst-${index}`, 10_000 + index, 'opened'),
        tenantId: tenant,
      };
    });
    const queued = await Promise.all(
      jobs.map((payload, index) => workers[index % workers.length]!.enqueue(payload)),
    );
    assert.equal(queued.filter((result) => result.accepted).length, jobs.length);

    const activeByTenant = new Map<string, number>();
    const peakByTenant = new Map<string, number>();
    const completed = new Set<string>();
    await Promise.all(
      workers.map(async (worker) => {
        for (;;) {
          const claimed = await worker.dequeue();
          if (!claimed) return;
          const active = (activeByTenant.get(claimed.tenantId) ?? 0) + 1;
          activeByTenant.set(claimed.tenantId, active);
          peakByTenant.set(
            claimed.tenantId,
            Math.max(peakByTenant.get(claimed.tenantId) ?? 0, active),
          );
          try {
            await new Promise<void>((resolve) => setTimeout(resolve, 1));
            const id = jobIdempotencyKey(claimed);
            assert.equal(completed.has(id), false, `duplicate claim for ${id}`);
            completed.add(id);
          } finally {
            // The Redis tenant slot is released by markCompleted below. Count
            // only the actual execution window, not local post-completion
            // cleanup that may overlap with the next eligible claim.
            activeByTenant.set(claimed.tenantId, active - 1);
          }
          await worker.markCompleted(claimed);
          await worker.releaseLockAndDrain(prKey(claimed));
        }
      }),
    );

    assert.equal(completed.size, jobs.length);
    assert.ok(
      [...peakByTenant.values()].every((peak) => peak <= plan.tenantConcurrency),
      'no tenant can exceed its Redis-held fleet review allocation',
    );
    assert.equal(await cleanup.hlen(`${namespace}:tenant-active`), 0);
    assert.equal(await cleanup.zcard(`${namespace}:tenant-claim-expiry`), 0);
  },
);

test(
  'Redis persistJob writes runId into PROCESSING so orphan recovery keeps it',
  { skip: !redisUrl },
  async (t) => {
    const cleanup = new Redis(redisUrl!);
    const namespace = testNamespace();
    t.after(async () => {
      await clearNamespace(cleanup, namespace);
      await cleanup.quit();
    });

    const queue = new RedisReviewQueue(redisUrl!, { namespace });
    t.after(async () => {
      await queue.close();
    });

    const payload = job('sha-persist', 99, 'opened');
    assert.equal((await queue.enqueue(payload)).accepted, true);
    const dequeued = await queue.dequeue();
    assert.ok(dequeued);
    dequeued!.runId = 'run-after-reserve';
    await queue.persistJob!(dequeued!);

    const [persistedEntry] = await cleanup.lrange(`${namespace}:processing`, 0, -1);
    assert.ok(persistedEntry);
    // Age past PROCESSING_RECOVERY_GRACE_MS and drop the live lease so recovery
    // requeues the persisted payload (including runId).
    await cleanup.set(
      `${namespace}:processing-meta:${createHash('sha256').update(persistedEntry!).digest('hex')}`,
      String(Date.now() - 60_000),
    );
    await cleanup.del(`${namespace}:inflight:${prKey(dequeued!)}`);

    const recovered = new RedisReviewQueue(redisUrl!, { namespace, maxResumeAfterRestart: 2 });
    t.after(async () => {
      await recovered.close();
    });
    assert.equal(await recovered.recoverOrphans(), 1);
    const again = await recovered.dequeue();
    assert.equal(again?.runId, 'run-after-reserve');
    await recovered.markFailed(again!, queueFailure('invalid_payload', 'done'));
  },
);

test(
  'Redis dead-letters an orphaned paid claim and replays it only by operator decision',
  { skip: !redisUrl },
  async (t) => {
    const cleanup = new Redis(redisUrl!);
    const namespace = testNamespace();
    const owner = new RedisReviewQueue(redisUrl!, { namespace });
    const restarted = new RedisReviewQueue(redisUrl!, { namespace });
    t.after(async () => {
      await owner.close();
      await restarted.close();
      await clearNamespace(cleanup, namespace);
      await cleanup.quit();
    });

    const payload = job('sha-no-replay', 100, 'opened');
    await owner.enqueue(payload);
    const claimed = await owner.dequeue();
    assert.ok(claimed);
    const [entry] = await cleanup.lrange(`${namespace}:processing`, 0, -1);
    assert.ok(entry);
    await cleanup.del(`${namespace}:inflight:${prKey(claimed!)}`);
    await cleanup.set(
      `${namespace}:processing-meta:${createHash('sha256').update(entry!).digest('hex')}`,
      String(Date.now() - 60_000),
    );

    assert.equal(await restarted.recoverOrphans(), 0);
    assert.equal(await cleanup.llen(`${namespace}:processing`), 0);
    assert.equal(await restarted.dequeue(), null);
    const [deadLetter] = await restarted.listDeadLetters!();
    assert.ok(deadLetter);
    assert.equal(deadLetter.reason, 'resume_limit_exceeded');
    assert.equal(await restarted.getJobState(jobIdempotencyKey(payload)), 'dead-lettered');
    assert.deepEqual(deadLetter.job, payload);
    assert.deepEqual(restarted.drainOperationalEvents!(), [
      { type: 'dead-lettered', record: deadLetter, source: 'orphan-recovery' },
    ]);
    assert.equal(await restarted.replayDeadLetter!(deadLetter.id), true);
    assert.equal(await restarted.getJobState(jobIdempotencyKey(payload)), 'ready');
    assert.equal(await restarted.replayDeadLetter!(deadLetter.id), false);
    const replayed = await restarted.dequeue();
    assert.deepEqual(replayed, payload);
    await restarted.markFailed(replayed!, queueFailure('invalid_payload', 'test cleanup'));
  },
);

test(
  'Redis terminal failure is claim-fenced, listed, alerted, and replayed once',
  { skip: !redisUrl },
  async (t) => {
    const cleanup = new Redis(redisUrl!);
    const namespace = testNamespace();
    const queue = new RedisReviewQueue(redisUrl!, { namespace });
    t.after(async () => {
      await queue.close();
      await clearNamespace(cleanup, namespace);
      await cleanup.quit();
    });

    const payload = job('sha-terminal', 101, 'opened');
    await queue.enqueue(payload);
    const claimed = await queue.dequeue();
    assert.ok(claimed);
    await queue.markRunning(claimed!);
    assert.equal(
      await queue.markFailed(claimed!, queueFailure('execution_failed', 'provider exhausted')),
      true,
    );
    const [record] = await queue.listDeadLetters!();
    assert.ok(record);
    assert.equal(record.reason, 'execution_failed');
    assert.equal(record.error, 'provider exhausted');
    assert.equal(await queue.getJobState(jobIdempotencyKey(payload)), 'dead-lettered');
    assert.deepEqual(queue.drainOperationalEvents!(), [
      { type: 'dead-lettered', record, source: 'terminal-failure' },
    ]);
    assert.equal(await queue.replayDeadLetter!(record.id), true);
    assert.equal(await queue.replayDeadLetter!(record.id), false);
    assert.deepEqual(await queue.dequeue(), payload);
  },
);

test(
  'Redis renewLease rebinds a missing tenant claim and persistJob refreshes TTLs',
  { skip: !redisUrl },
  async (t) => {
    const cleanup = new Redis(redisUrl!);
    const namespace = testNamespace();
    const plan = {
      epoch: 'tenant-rebind-v1',
      limits: { luna: 2, deepseek: 2, minimax: 2 },
      tenantConcurrency: 2,
    };
    const queue = new RedisReviewQueue(redisUrl!, { namespace, providerCapacityPlan: plan });
    const scheduler =
      queue.providerAdmission as import('./redis-provider-admission.js').RedisProviderAdmission;
    t.after(async () => {
      await queue.close();
      await clearNamespace(cleanup, namespace);
      await cleanup.quit();
    });
    await scheduler.initializeProviderCapacities();

    const payload = { ...job('sha-rebind', 88, 'opened'), tenantId: 'tenant-rebind' };
    assert.equal((await queue.enqueue(payload)).accepted, true);
    const claimed = await queue.dequeue();
    assert.ok(claimed);
    const [entry] = await cleanup.lrange(`${namespace}:processing`, 0, -1);
    assert.ok(entry);
    const token = entry!.slice(0, entry!.indexOf('\n'));
    await cleanup.hdel(`${namespace}:tenant-claims`, token);
    await cleanup.hdel(`${namespace}:tenant-active`, 'tenant-rebind');
    await cleanup.zrem(`${namespace}:tenant-claim-expiry`, token);

    await queue.renewLease!(claimed!);
    assert.equal(await cleanup.hget(`${namespace}:tenant-claims`, token), 'tenant-rebind');
    assert.equal(await cleanup.hget(`${namespace}:tenant-active`, 'tenant-rebind'), '1');
    const expiryAfterRenew = Number(await cleanup.zscore(`${namespace}:tenant-claim-expiry`, token));
    assert.ok(expiryAfterRenew > Date.now());

    const inflightTtlBefore = await cleanup.ttl(`${namespace}:inflight:${prKey(claimed!)}`);
    claimed!.runId = 'run-persist-refresh';
    await queue.persistJob!(claimed!);
    const inflightTtlAfter = await cleanup.ttl(`${namespace}:inflight:${prKey(claimed!)}`);
    assert.ok(inflightTtlAfter >= inflightTtlBefore - 1);
    const [persistedEntry] = await cleanup.lrange(`${namespace}:processing`, 0, -1);
    assert.ok(persistedEntry);
    const metaTtl = await cleanup.ttl(
      `${namespace}:processing-meta:${createHash('sha256').update(persistedEntry!).digest('hex')}`,
    );
    assert.ok(metaTtl > 0);
    const expiryAfterPersist = Number(
      await cleanup.zscore(`${namespace}:tenant-claim-expiry`, token),
    );
    assert.ok(expiryAfterPersist >= expiryAfterRenew - 1_000);
    await queue.markCompleted(claimed!);
  },
);

test(
  'Redis renewLease still succeeds after persistJob rewrites the job payload',
  { skip: !redisUrl },
  async (t) => {
    const cleanup = new Redis(redisUrl!);
    const namespace = testNamespace();
    t.after(async () => {
      await clearNamespace(cleanup, namespace);
      await cleanup.quit();
    });

    const queue = new RedisReviewQueue(redisUrl!, { namespace });
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
    await assert.rejects(queue.renewLease!(dequeued!), /lease lost.*claim token missing/i);
  },
);

test(
  'a stale worker cannot clear a newer claim processing record or dedup marker',
  { skip: !redisUrl },
  async (t) => {
    const cleanup = new Redis(redisUrl!);
    const namespace = testNamespace();
    t.after(async () => {
      await clearNamespace(cleanup, namespace);
      await cleanup.quit();
    });

    const queue = new RedisReviewQueue(redisUrl!, { namespace });
    t.after(async () => {
      await queue.close();
    });

    const payload = job('sha-stale-finalizer', 78, 'opened');
    assert.equal((await queue.enqueue(payload)).accepted, true);
    const stale = await queue.dequeue();
    assert.ok(stale);
    const raw = JSON.stringify(stale);
    const lockKey = `${namespace}:inflight:${prKey(stale!)}`;
    const seenKey = `${namespace}:seen:${jobIdempotencyKey(stale!)}`;
    const [staleEntry] = await cleanup.lrange(`${namespace}:processing`, 0, -1);
    assert.ok(staleEntry);
    const currentEntry = `new-owner-token\n${raw}`;

    // Simulate lease expiry followed by another worker claiming this same
    // durable payload. The old worker still holds its prior token locally, but
    // PROCESSING now belongs to the newer immutable claim.
    await cleanup.set(lockKey, `new-owner-token\n${raw}`, 'EX', 900);
    await cleanup.lset(`${namespace}:processing`, 0, currentEntry);
    await assert.rejects(queue.markCompleted(stale!), /lease lost before completion/);

    assert.match((await cleanup.get(lockKey)) ?? '', /^new-owner-token\n/);
    assert.deepEqual(await cleanup.lrange(`${namespace}:processing`, 0, -1), [currentEntry]);
    assert.equal(await cleanup.exists(seenKey), 1);
    assert.equal(
      await cleanup.exists(`${namespace}:done:${jobIdempotencyKey(stale!)}`),
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
    const namespace = testNamespace();
    const first = new RedisReviewQueue(redisUrl!, { namespace });
    const second = new RedisReviewQueue(redisUrl!, { namespace });
    t.after(async () => {
      await first.close();
      await second.close();
      await clearNamespace(cleanup, namespace);
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
    assert.ok(
      (await second.getProviderCooldownMs('deepseek')) > 0,
      'cooldown is visible to peer worker',
    );
  },
);

test(
  'hundreds of simultaneous reviews drain exactly once across Redis workers',
  { skip: !redisUrl },
  async (t) => {
    const cleanup = new Redis(redisUrl!);
    const namespace = testNamespace();
    const workers = Array.from({ length: 8 }, () => new RedisReviewQueue(redisUrl!, { namespace }));
    t.after(async () => {
      await Promise.all(workers.map((worker) => worker.close()));
      await clearNamespace(cleanup, namespace);
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
    const namespace = testNamespace();
    const workers = Array.from({ length: 6 }, () => new RedisReviewQueue(redisUrl!, { namespace }));
    t.after(async () => {
      await Promise.all(workers.map((worker) => worker.close()));
      await clearNamespace(cleanup, namespace);
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
  'Redis recovery lease elects one periodic recovery owner and fences stale release',
  { skip: !redisUrl },
  async (t) => {
    const cleanup = new Redis(redisUrl!);
    const namespace = testNamespace();
    const first = new RedisReviewQueue(redisUrl!, { namespace });
    const second = new RedisReviewQueue(redisUrl!, { namespace });
    t.after(async () => {
      await first.close();
      await second.close();
      await clearNamespace(cleanup, namespace);
      await cleanup.quit();
    });

    const firstToken = await first.acquireRecoveryLease!();
    assert.ok(firstToken);
    assert.equal(await second.acquireRecoveryLease!(), null);

    // Simulate expiry/re-election. A stale owner must not delete the newer
    // leader's lease during its finally block.
    await cleanup.del(`${namespace}:recovery-leader`);
    const secondToken = await second.acquireRecoveryLease!();
    assert.ok(secondToken);
    await first.releaseRecoveryLease!(firstToken!);
    assert.equal(await first.acquireRecoveryLease!(), null);
    await second.releaseRecoveryLease!(secondToken!);
    assert.ok(await first.acquireRecoveryLease!());
  },
);

test(
  'a stale worker cannot resurrect its obsolete SHA after a newer owner finishes',
  { skip: !redisUrl },
  async (t) => {
    const cleanup = new Redis(redisUrl!);
    const namespace = testNamespace();
    const staleWorker = new RedisReviewQueue(redisUrl!, { namespace });
    const currentWorker = new RedisReviewQueue(redisUrl!, { namespace });
    t.after(async () => {
      await Promise.all([staleWorker.close(), currentWorker.close()]);
      await clearNamespace(cleanup, namespace);
      await cleanup.quit();
    });

    const stale = job('sha-stale-owner', 1_900, 'opened');
    assert.equal((await staleWorker.enqueue(stale)).accepted, true);
    const staleClaim = await staleWorker.dequeue();
    assert.ok(staleClaim);

    await cleanup.del(`${namespace}:inflight:${prKey(stale)}`);
    const current = job('sha-current-owner', stale.pr, 'synchronize');
    assert.equal((await currentWorker.enqueue(current)).accepted, true);
    const currentClaim = await currentWorker.dequeue();
    assert.deepEqual(currentClaim, current);

    await staleWorker.markFailed(staleClaim!, queueFailure('lease_lost', 'lease lost'));
    await currentWorker.markCompleted(currentClaim!);
    assert.equal(await currentWorker.releaseLockAndDrain(prKey(current)), null);

    assert.equal(await currentWorker.recoverOrphans(), 0);
    assert.equal(await currentWorker.dequeue(), null, 'the stale SHA was retired, not requeued');
  },
);

test('two workers atomically recover an orphan exactly once', { skip: !redisUrl }, async (t) => {
  const cleanup = new Redis(redisUrl!);
  const namespace = testNamespace();
  const owner = new RedisReviewQueue(redisUrl!, { namespace });
  const payload = job('sha-recovery-race', 81, 'opened');
  await owner.enqueue(payload);
  const claimed = await owner.dequeue();
  assert.ok(claimed);
  const [processingEntry] = await cleanup.lrange(`${namespace}:processing`, 0, -1);
  assert.ok(processingEntry);
  await owner.close();
  await cleanup.del(`${namespace}:inflight:${prKey(claimed!)}`);
  await cleanup.set(
    `${namespace}:processing-meta:${createHash('sha256').update(processingEntry!).digest('hex')}`,
    String(Date.now() - 60_000),
  );

  const a = new RedisReviewQueue(redisUrl!, { namespace, maxResumeAfterRestart: 2 });
  const b = new RedisReviewQueue(redisUrl!, { namespace, maxResumeAfterRestart: 2 });
  t.after(async () => {
    await a.close();
    await b.close();
    await clearNamespace(cleanup, namespace);
    await cleanup.quit();
  });
  const recovered = await Promise.all([a.recoverOrphans(), b.recoverOrphans()]);
  assert.equal(recovered[0]! + recovered[1]!, 1);
  assert.equal(await cleanup.llen(`${namespace}:jobs`), 1);
  assert.equal(await cleanup.llen(`${namespace}:processing`), 0);
});

test(
  'Redis dequeue honors priority and reports pending depth without a key scan',
  { skip: !redisUrl },
  async (t) => {
    const cleanup = new Redis(redisUrl!);
    const namespace = testNamespace();
    const queue = new RedisReviewQueue(redisUrl!, { namespace });
    t.after(async () => {
      await queue.close();
      await clearNamespace(cleanup, namespace);
      await cleanup.quit();
    });

    const low = { ...job('low', 91, 'manual'), priority: 0 };
    const high = { ...job('high', 92, 'manual'), priority: 3 };
    await queue.enqueue(low);
    await queue.enqueue(high);
    const claimedHigh = await queue.dequeue();
    assert.equal(claimedHigh?.headSha, 'high');
    await queue.enqueue({ ...job('high-next', 92, 'synchronize'), priority: 3 });
    assert.equal((await queue.depth!()).waitingOnPr, 1);
    assert.equal((await queue.dequeue())?.headSha, 'low');
  },
);

test(
  'Redis priority bursts always yield one FIFO job under a continuous higher-priority stream',
  { skip: !redisUrl },
  async (t) => {
    const cleanup = new Redis(redisUrl!);
    const namespace = testNamespace();
    const queue = new RedisReviewQueue(redisUrl!, { namespace });
    t.after(async () => {
      await queue.close();
      await clearNamespace(cleanup, namespace);
      await cleanup.quit();
    });

    const low = { ...job('low-fifo', 2_000, 'manual'), priority: 0 };
    await queue.enqueue(low);
    for (let index = 0; index < 8; index += 1) {
      await queue.enqueue({
        ...job(`high-initial-${index}`, 2_100 + index, 'manual'),
        priority: 3,
      });
    }

    for (let index = 0; index < 8; index += 1) {
      const high = await queue.dequeue();
      assert.match(high?.headSha ?? '', /^high-/);
      await queue.markCompleted(high!);
      await queue.releaseLockAndDrain(prKey(high!));
      // Keep high-priority work arriving while the low-priority head waits.
      await queue.enqueue({
        ...job(`high-continuous-${index}`, 2_200 + index, 'manual'),
        priority: 3,
      });
    }

    const forcedFifo = await queue.dequeue();
    assert.equal(forcedFifo?.headSha, low.headSha);
    await queue.markCompleted(forcedFifo!);
    await queue.releaseLockAndDrain(prKey(forcedFifo!));
  },
);

test(
  'Redis orphan recovery scans processing incrementally instead of blocking on the full list',
  { skip: !redisUrl },
  async (t) => {
    const cleanup = new Redis(redisUrl!);
    const namespace = testNamespace();
    const queue = new RedisReviewQueue(redisUrl!, { namespace });
    t.after(async () => {
      await queue.close();
      await clearNamespace(cleanup, namespace);
      await cleanup.quit();
    });

    const malformed = Array.from({ length: 1_200 }, (_, index) => `malformed-${index}`);
    await cleanup.rpush(`${namespace}:processing`, ...malformed);
    await queue.recoverOrphans();
    assert.equal(await cleanup.llen(`${namespace}:processing`), 700);
    await queue.recoverOrphans();
    assert.equal(await cleanup.llen(`${namespace}:processing`), 500);
    await queue.recoverOrphans();
    assert.equal(await cleanup.llen(`${namespace}:processing`), 0);
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
