import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { CLAIM_LUA, DEQUEUE_LUA, DRAIN_LUA, ENQUEUE_LUA } from './redis-scripts.js';
import {
  LEASE_TTL_SECONDS,
  PROCESSING_META_TTL_SECONDS,
  SEEN_TTL_SECONDS,
  STATE_TTL_SECONDS,
  type RedisQueueKeys,
  processingMetaKey,
} from './redis-keys.js';
import {
  jobIdempotencyKey,
  prKey,
  reviewShaIdempotencyKey,
  type EnqueueResult,
  type ReviewJobPayload,
} from './types.js';

export interface ClaimTokens {
  get(job: ReviewJobPayload): string | undefined;
  set(job: ReviewJobPayload, value: string): void;
}

/** Owns arrival ordering, deduplication, priority selection, and PR coalescing. */
export class RedisEnqueueOperations {
  constructor(
    private readonly redis: Redis,
    private readonly keys: RedisQueueKeys,
    private readonly claims: ClaimTokens,
  ) {}

  async enqueue(job: ReviewJobPayload): Promise<EnqueueResult> {
    const idKey = jobIdempotencyKey(job);
    const bare = reviewShaIdempotencyKey(job);
    if (await this.isCompleted(job, idKey, bare)) {
      return { accepted: false, jobId: idKey, reason: 'duplicate' };
    }
    const result = await this.redis.eval(
      ENQUEUE_LUA,
      6,
      `${this.keys.seenPrefix}${idKey}`,
      `${this.keys.inflightPrefix}${prKey(job)}`,
      `${this.keys.pendingPrefix}${prKey(job)}`,
      this.keys.queue,
      this.keys.pendingCount,
      `${this.keys.statePrefix}${idKey}`,
      JSON.stringify(job),
      job.kind ?? 'review',
      SEEN_TTL_SECONDS,
      this.keys.seenPrefix,
      this.keys.statePrefix,
      STATE_TTL_SECONDS,
    );
    if (result === 'duplicate') return { accepted: false, jobId: idKey, reason: 'duplicate' };
    return {
      accepted: true,
      jobId: idKey,
      reason: result === 'coalesced' ? 'coalesced' : 'enqueued',
    };
  }

  async dequeue(): Promise<ReviewJobPayload | null> {
    for (let index = 0; index < 50; index += 1) {
      const token = randomUUID();
      const raw = (await this.redis.eval(
        DEQUEUE_LUA,
        2,
        this.keys.queue,
        this.keys.processing,
        token,
      )) as string | null | false;
      if (!raw) return null;
      const processingEntry = `${token}\n${raw}`;
      let job: ReviewJobPayload;
      try {
        job = JSON.parse(raw) as ReviewJobPayload;
      } catch {
        await this.redis.lrem(this.keys.processing, 1, processingEntry);
        continue;
      }
      const idKey = jobIdempotencyKey(job);
      const bare = reviewShaIdempotencyKey(job);
      if (await this.isCompleted(job, idKey, bare)) {
        await this.redis.lrem(this.keys.processing, 1, processingEntry);
        continue;
      }
      const claimResult = await this.redis.eval(
        CLAIM_LUA,
        4,
        `${this.keys.inflightPrefix}${prKey(job)}`,
        `${this.keys.pendingPrefix}${prKey(job)}`,
        this.keys.pendingCount,
        `${this.keys.statePrefix}${idKey}`,
        raw,
        job.kind ?? 'review',
        LEASE_TTL_SECONDS,
        token,
        this.keys.seenPrefix,
        this.keys.statePrefix,
        STATE_TTL_SECONDS,
      );
      if (claimResult === 'pending') {
        await this.redis.lrem(this.keys.processing, 1, processingEntry);
        continue;
      }
      await this.redis.set(
        processingMetaKey(this.keys.processingMetaPrefix, processingEntry),
        String(Date.now()),
        'EX',
        PROCESSING_META_TTL_SECONDS,
      );
      this.claims.set(job, processingEntry);
      return job;
    }
    return null;
  }

  async releaseLockAndDrain(pr: string): Promise<ReviewJobPayload | null> {
    const raw = (await this.redis.eval(
      DRAIN_LUA,
      3,
      `${this.keys.pendingPrefix}${pr}`,
      this.keys.queue,
      this.keys.pendingCount,
    )) as string | null | false;
    return raw ? (JSON.parse(raw) as ReviewJobPayload) : null;
  }

  private async isCompleted(job: ReviewJobPayload, idKey: string, bare: string): Promise<boolean> {
    if (await this.redis.exists(`${this.keys.donePrefix}${idKey}`)) return true;
    return (
      idKey !== bare &&
      (job.kind ?? 'review') === 'review' &&
      job.action !== 'command' &&
      job.action !== 'manual' &&
      (await this.redis.exists(`${this.keys.donePrefix}${bare}`)) === 1
    );
  }
}
