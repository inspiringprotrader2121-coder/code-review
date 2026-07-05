import { Redis } from 'ioredis';
import {
  jobIdempotencyKey,
  prKey,
  type EnqueueResult,
  type ReviewJobPayload,
  type ReviewQueue,
} from './types.js';

const QUEUE_KEY = 'orvex-review:jobs';
const SEEN_PREFIX = 'orvex-review:seen:';
const DONE_PREFIX = 'orvex-review:done:';
const INFLIGHT_PREFIX = 'orvex-review:inflight:';
const PENDING_PREFIX = 'orvex-review:pending:';

export class RedisReviewQueue implements ReviewQueue {
  private redis: Redis;

  constructor(url: string) {
    this.redis = new Redis(url);
  }

  async enqueue(job: ReviewJobPayload): Promise<EnqueueResult> {
    const idKey = jobIdempotencyKey(job);
    const pk = prKey(job);

    // Already completed this exact job? reject.
    if (await this.redis.exists(`${DONE_PREFIX}${idKey}`)) {
      return { accepted: false, jobId: idKey, reason: 'duplicate' };
    }

    // Atomically CLAIM the idempotency key: `SET NX` returns null if it already
    // existed. This closes the check-then-set race the old exists()+set() had —
    // GitHub redelivers webhooks on timeout, and two identical deliveries hitting
    // the endpoint concurrently would both pass a plain exists() and both enqueue.
    const claimed = await this.redis.set(`${SEEN_PREFIX}${idKey}`, '1', 'EX', 86400, 'NX');
    if (claimed === null) {
      return { accepted: false, jobId: idKey, reason: 'duplicate' };
    }

    const inflight = await this.redis.exists(`${INFLIGHT_PREFIX}${pk}`);
    if (inflight) {
      // pending is a LIST; coalesce only a trailing review-after-review so a
      // fix/ask/resolve command is never overwritten by a later review.
      const kind = job.kind ?? 'review';
      const lastRaw = await this.redis.lindex(`${PENDING_PREFIX}${pk}`, -1);
      const lastKind = lastRaw ? (JSON.parse(lastRaw).kind ?? 'review') : null;
      if (kind === 'review' && lastKind === 'review') {
        await this.redis.lset(`${PENDING_PREFIX}${pk}`, -1, JSON.stringify(job));
      } else {
        await this.redis.rpush(`${PENDING_PREFIX}${pk}`, JSON.stringify(job));
      }
      return { accepted: true, jobId: idKey, reason: 'coalesced' };
    }

    await this.redis.rpush(QUEUE_KEY, JSON.stringify(job));
    return { accepted: true, jobId: idKey, reason: 'enqueued' };
  }

  async dequeue(): Promise<ReviewJobPayload | null> {
    // Return the first genuinely-runnable job, skipping (a) SHAs already reviewed
    // and (b) PRs already being processed. Bounded so a queue full of duplicates
    // can't spin forever.
    for (let i = 0; i < 50; i++) {
      const raw = await this.redis.lpop(QUEUE_KEY);
      if (!raw) return null;
      const job = JSON.parse(raw) as ReviewJobPayload;
      const pk = prKey(job);

      // Already completed this exact review (same SHA/action)? never re-review it.
      if (await this.redis.exists(`${DONE_PREFIX}${jobIdempotencyKey(job)}`)) continue;

      // Claim the PR atomically. If a review for this PR is ALREADY running, do
      // NOT start a second one concurrently — stash this as the pending "latest"
      // so it runs once, after the current one finishes. `SET NX` returns null
      // when the lock already exists.
      const claimed = await this.redis.set(`${INFLIGHT_PREFIX}${pk}`, job.headSha, 'EX', 3600, 'NX');
      if (claimed === null) {
        await this.coalesceToPending(pk, raw);
        continue;
      }
      return job;
    }
    return null;
  }

  /** Stash a job in a PR's pending list, keeping only the LATEST review (older
   *  same-PR reviews are superseded); command jobs are appended, never dropped. */
  private async coalesceToPending(pk: string, raw: string): Promise<void> {
    const kind = (JSON.parse(raw) as ReviewJobPayload).kind ?? 'review';
    const lastRaw = await this.redis.lindex(`${PENDING_PREFIX}${pk}`, -1);
    const lastKind = lastRaw ? ((JSON.parse(lastRaw) as ReviewJobPayload).kind ?? 'review') : null;
    if (kind === 'review' && lastKind === 'review') {
      await this.redis.lset(`${PENDING_PREFIX}${pk}`, -1, raw);
    } else {
      await this.redis.rpush(`${PENDING_PREFIX}${pk}`, raw);
    }
  }

  async markCompleted(job: ReviewJobPayload): Promise<void> {
    const idKey = jobIdempotencyKey(job);
    await Promise.all([
      this.redis.set(`${DONE_PREFIX}${idKey}`, '1', 'EX', 604800),
      this.redis.del(`${INFLIGHT_PREFIX}${prKey(job)}`),
    ]);
  }

  async markFailed(job: ReviewJobPayload, _error: string): Promise<void> {
    const idKey = jobIdempotencyKey(job);
    await Promise.all([
      this.redis.del(`${SEEN_PREFIX}${idKey}`),
      this.redis.del(`${INFLIGHT_PREFIX}${prKey(job)}`),
    ]);
  }

  async releaseLockAndDrain(prKeyStr: string): Promise<ReviewJobPayload | null> {
    const raw = await this.redis.lpop(`${PENDING_PREFIX}${prKeyStr}`);
    if (!raw) return null;

    const job = JSON.parse(raw) as ReviewJobPayload;
    await this.redis.rpush(QUEUE_KEY, JSON.stringify(job));
    return job;
  }

  /**
   * Startup recovery. After a restart NOTHING is genuinely in-flight, so any
   * leftover `inflight:` locks are stale — and while they exist, enqueue coalesces
   * new pushes for that PR into `pending:` and they never run (nothing drains
   * pending unless a job completes). This clears stale inflight locks and moves
   * any pending jobs back onto the main queue so no PR is left blocked. Call once
   * at startup before the worker loop starts.
   */
  async recoverOrphans(): Promise<number> {
    const inflight = await this.redis.keys(`${INFLIGHT_PREFIX}*`);
    if (inflight.length > 0) await this.redis.del(...inflight);

    let requeued = 0;
    const pendingKeys = await this.redis.keys(`${PENDING_PREFIX}*`);
    for (const key of pendingKeys) {
      for (;;) {
        const raw = await this.redis.lpop(key);
        if (!raw) break;
        // clear the dedup marker so the requeued job is accepted, then queue it
        try {
          const job = JSON.parse(raw) as ReviewJobPayload;
          await this.redis.del(`${SEEN_PREFIX}${jobIdempotencyKey(job)}`);
        } catch {
          /* keep going even if one entry is malformed */
        }
        await this.redis.rpush(QUEUE_KEY, raw);
        requeued++;
      }
    }
    return inflight.length + requeued;
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.redis.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}
