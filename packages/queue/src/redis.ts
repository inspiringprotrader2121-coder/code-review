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

    const [done, seen] = await Promise.all([
      this.redis.exists(`${DONE_PREFIX}${idKey}`),
      this.redis.exists(`${SEEN_PREFIX}${idKey}`),
    ]);

    if (done || seen) {
      return { accepted: false, jobId: idKey, reason: 'duplicate' };
    }

    await this.redis.set(`${SEEN_PREFIX}${idKey}`, '1', 'EX', 86400);

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
    const raw = await this.redis.lpop(QUEUE_KEY);
    if (!raw) return null;

    const job = JSON.parse(raw) as ReviewJobPayload;
    await this.redis.set(`${INFLIGHT_PREFIX}${prKey(job)}`, job.headSha, 'EX', 3600);
    return job;
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

  async close(): Promise<void> {
    await this.redis.quit();
  }
}
