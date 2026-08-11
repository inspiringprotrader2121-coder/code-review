import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import {
  RECOVER_PENDING_LUA,
  RECOVER_PROCESSING_LUA,
  REPLAY_DEAD_LETTER_LUA,
} from './redis-scripts.js';
import {
  PROCESSING_RECOVERY_GRACE_MS,
  SEEN_TTL_SECONDS,
  STATE_TTL_SECONDS,
  parseProcessingEntry,
  processingMetaKey,
  type RedisQueueKeys,
} from './redis-keys.js';
import {
  jobIdempotencyKey,
  prKey,
  reviewShaIdempotencyKey,
  type DeadLetterRecord,
  type QueueFailureCode,
  type QueueOperationalEvent,
  type ReviewJobPayload,
} from './types.js';
import { RedisQueueTransitionRepository } from './redis-transitions.js';

/** Owns bounded leader-safe recovery and explicit dead-letter replay. */
export class RedisRecoveryOperations {
  private pendingRecoveryCursor = '0';
  private processingRecoveryOffset = 0;

  constructor(
    private readonly redis: Redis,
    private readonly keys: RedisQueueKeys,
    private readonly transitions: RedisQueueTransitionRepository,
    private readonly maxResumeAfterRestart: number,
    private readonly onOperationalEvent?: (event: QueueOperationalEvent) => void,
  ) {}

  async recoverOrphans(): Promise<number> {
    let requeued = 0;
    const processingLength = await this.redis.llen(this.keys.processing);
    if (processingLength === 0 || this.processingRecoveryOffset >= processingLength)
      this.processingRecoveryOffset = 0;
    const processing =
      processingLength > 0
        ? await this.redis.lrange(
            this.keys.processing,
            this.processingRecoveryOffset,
            this.processingRecoveryOffset + 499,
          )
        : [];
    this.processingRecoveryOffset =
      processingLength > 0 && this.processingRecoveryOffset + processing.length < processingLength
        ? this.processingRecoveryOffset + processing.length
        : 0;
    for (const entry of processing) requeued += await this.recoverProcessingEntry(entry);

    const pendingPage = await this.scanKeysPage(
      `${this.keys.pendingPrefix}*`,
      this.pendingRecoveryCursor,
      500,
    );
    this.pendingRecoveryCursor = pendingPage.cursor;
    for (const pendingKey of pendingPage.keys) requeued += await this.drainPendingKey(pendingKey);
    return requeued;
  }

  async listDeadLetters(limit = 50): Promise<DeadLetterRecord[]> {
    const records = await this.redis.lrange(
      this.keys.deadLetters,
      0,
      Math.min(500, Math.max(1, Math.floor(limit))) - 1,
    );
    const parsed: DeadLetterRecord[] = [];
    for (const record of records) {
      try {
        const stored = JSON.parse(record) as Omit<DeadLetterRecord, 'job'> & { job: string };
        const job = JSON.parse(stored.job) as ReviewJobPayload;
        if (stored.id && stored.failedAt && isQueueFailureCode(stored.reason))
          parsed.push({ ...stored, job });
      } catch {
        // Corrupt dead-letter records remain durable for manual inspection.
      }
    }
    return parsed;
  }

  async replayDeadLetter(id: string): Promise<boolean> {
    const records = await this.redis.lrange(this.keys.deadLetters, 0, 9_999);
    for (const rawRecord of records) {
      try {
        const stored = JSON.parse(rawRecord) as Omit<DeadLetterRecord, 'job'> & { job: string };
        if (stored.id !== id) continue;
        const job = JSON.parse(stored.job) as ReviewJobPayload;
        const idKey = jobIdempotencyKey(job);
        const decision = JSON.stringify({
          deadLetterId: id,
          action: 'replayed',
          decidedAt: new Date().toISOString(),
          jobId: idKey,
        });
        const result = await this.redis.eval(
          REPLAY_DEAD_LETTER_LUA,
          6,
          this.keys.deadLetters,
          `${this.keys.seenPrefix}${idKey}`,
          this.keys.queue,
          `${this.keys.donePrefix}${reviewShaIdempotencyKey(job)}`,
          this.keys.deadLetterDecisions,
          `${this.keys.statePrefix}${idKey}`,
          rawRecord,
          stored.job,
          SEEN_TTL_SECONDS,
          decision,
        );
        return result === 'replayed';
      } catch {
        // Continue searching; malformed records cannot be replayed.
      }
    }
    return false;
  }

  private async recoverProcessingEntry(entry: string): Promise<number> {
    const { token, raw } = parseProcessingEntry(entry);
    let job: ReviewJobPayload;
    try {
      job = JSON.parse(raw) as ReviewJobPayload;
    } catch {
      await this.redis.lrem(this.keys.processing, 1, entry);
      await this.redis.del(processingMetaKey(this.keys.processingMetaPrefix, entry));
      await this.transitions.releaseTenantClaim(this.keys, token);
      return 0;
    }
    const idKey = jobIdempotencyKey(job);
    const bare = reviewShaIdempotencyKey(job);
    const automatic =
      (job.kind ?? 'review') === 'review' && job.action !== 'command' && job.action !== 'manual';
    const failedAt = new Date().toISOString();
    const deadLetterId = randomUUID();
    const recovered = String(
      await this.redis.eval(
        RECOVER_PROCESSING_LUA,
        13,
        this.keys.processing,
        processingMetaKey(this.keys.processingMetaPrefix, entry),
        `${this.keys.inflightPrefix}${prKey(job)}`,
        `${this.keys.donePrefix}${idKey}`,
        `${this.keys.donePrefix}${automatic ? bare : idKey}`,
        `${this.keys.resumedPrefix}${idKey}`,
        `${this.keys.seenPrefix}${idKey}`,
        this.keys.queue,
        this.keys.deadLetters,
        `${this.keys.statePrefix}${idKey}`,
        this.keys.tenantActive,
        this.keys.tenantClaims,
        this.keys.tenantClaimExpiry,
        entry,
        Date.now(),
        PROCESSING_RECOVERY_GRACE_MS,
        this.maxResumeAfterRestart,
        token,
        raw,
        failedAt,
        deadLetterId,
        STATE_TTL_SECONDS,
      ),
    );
    if (recovered.startsWith('dead-lettered:')) {
      const attempts = Number.parseInt(recovered.slice('dead-lettered:'.length), 10);
      const record: DeadLetterRecord = {
        id: deadLetterId,
        job: { ...job },
        reason: 'resume_limit_exceeded',
        failedAt,
        attempts: Number.isFinite(attempts) ? attempts : this.maxResumeAfterRestart + 1,
      };
      this.onOperationalEvent?.({ type: 'dead-lettered', record, source: 'orphan-recovery' });
      console.error(
        `[queue] dead-lettered job ${idKey} after ${recovered.slice('dead-lettered:'.length)} restart recovery attempt(s) (cap ${this.maxResumeAfterRestart}); operator replay is required.`,
      );
    }
    return recovered === 'requeued' ? 1 : 0;
  }

  private async drainPendingKey(pendingKey: string): Promise<number> {
    const pendingPrKey = pendingKey.slice(this.keys.pendingPrefix.length);
    if (await this.redis.exists(`${this.keys.inflightPrefix}${pendingPrKey}`)) return 0;
    let requeued = 0;
    for (;;) {
      const raw = await this.redis.lindex(pendingKey, 0);
      if (!raw) return requeued;
      let job: ReviewJobPayload;
      try {
        job = JSON.parse(raw) as ReviewJobPayload;
      } catch {
        const removed = await this.redis.lrem(pendingKey, 1, raw);
        if (removed > 0) await this.transitions.decrementAtMost(this.keys.pendingCount, removed);
        continue;
      }
      const moved = await this.redis.eval(
        RECOVER_PENDING_LUA,
        5,
        pendingKey,
        `${this.keys.inflightPrefix}${pendingPrKey}`,
        `${this.keys.seenPrefix}${jobIdempotencyKey(job)}`,
        this.keys.queue,
        this.keys.pendingCount,
        raw,
      );
      if (!moved) return requeued;
      if (moved === 'retry') continue;
      requeued += 1;
    }
  }

  private async scanKeysPage(
    pattern: string,
    cursor: string,
    limit: number,
  ): Promise<{ cursor: string; keys: string[] }> {
    const keys: string[] = [];
    let next = cursor;
    do {
      const result = await this.redis.scan(next, 'MATCH', pattern, 'COUNT', 100);
      next = result[0];
      keys.push(...result[1]);
    } while (next !== '0' && keys.length < limit);
    return { cursor: next, keys: keys.slice(0, limit) };
  }
}

const QUEUE_FAILURE_CODES: readonly QueueFailureCode[] = [
  'resume_limit_exceeded',
  'invalid_payload',
  'pr_closed',
  'worker_restart',
  'worker_stopped',
  'provider_transient',
  'provider_permanent',
  'lease_lost',
  'cancelled',
  'execution_failed',
];

function isQueueFailureCode(value: unknown): value is QueueFailureCode {
  return typeof value === 'string' && QUEUE_FAILURE_CODES.includes(value as QueueFailureCode);
}
