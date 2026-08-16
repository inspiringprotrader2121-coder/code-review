import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { RedisQueueTransitionRepository } from './redis-transitions.js';
import {
  LEASE_TTL_SECONDS,
  PROCESSING_META_TTL_SECONDS,
  STATE_TTL_SECONDS,
  claimToken,
  processingMetaKey,
  type RedisQueueKeys,
} from './redis-keys.js';
import {
  draftSkipIdempotencyKey,
  jobIdempotencyKey,
  prKey,
  reviewShaIdempotencyKey,
  type MarkCompletedOptions,
  type DeadLetterRecord,
  type QueueOperationalEvent,
  type QueueFailure,
  type ReviewJobPayload,
  shouldDeadLetterFailure,
} from './types.js';
import type { QueueJobState } from './state-machine.js';

export interface MutableClaimTokens {
  get(job: ReviewJobPayload): string | undefined;
  set(job: ReviewJobPayload, value: string): void;
  delete(job: ReviewJobPayload): void;
}

/** Owns the fenced lease lifecycle and durable processing payload mutations. */
export class RedisLeaseOperations {
  constructor(
    private readonly redis: Redis,
    private readonly keys: RedisQueueKeys,
    private readonly transitions: RedisQueueTransitionRepository,
    private readonly claims: MutableClaimTokens,
    private readonly onOperationalEvent?: (event: QueueOperationalEvent) => void,
  ) {}

  async markCompleted(job: ReviewJobPayload, options?: MarkCompletedOptions): Promise<boolean> {
    const doneKeys = options?.draftSkipped
      ? [`${this.keys.donePrefix}${draftSkipIdempotencyKey(job)}`]
      : this.completedKeys(job);
    if (!(await this.finalize(job, false, 'succeeded', doneKeys))) {
      throw new Error(`review lease lost before completion for ${prKey(job)}`);
    }
    return true;
  }

  async renewLease(job: ReviewJobPayload): Promise<void> {
    const claim = this.requireClaim(job, 'lease lost');
    const renewed = await this.transitions.renewLease(
      `${this.keys.inflightPrefix}${prKey(job)}`,
      claimToken(claim),
      LEASE_TTL_SECONDS,
      this.keys,
      job.tenantId,
    );
    if (!renewed) throw new Error(`review lease lost for ${prKey(job)}`);
  }

  async markRunning(job: ReviewJobPayload): Promise<boolean> {
    const claim = this.claims.get(job);
    return claim
      ? this.transitions.markRunning(
          `${this.keys.inflightPrefix}${prKey(job)}`,
          `${this.keys.statePrefix}${jobIdempotencyKey(job)}`,
          claimToken(claim),
          STATE_TTL_SECONDS,
        )
      : false;
  }

  async persistJob(job: ReviewJobPayload): Promise<void> {
    const claim = this.requireClaim(job, 'lease lost before job persistence');
    const separator = claim.indexOf('\n');
    if (separator < 0)
      throw new Error(`invalid review claim before job persistence for ${prKey(job)}`);
    const token = claim.slice(0, separator);
    const oldRaw = claim.slice(separator + 1);
    const newRaw = JSON.stringify(job);
    const inflightKey = `${this.keys.inflightPrefix}${prKey(job)}`;
    let activeClaim = claim;
    if (newRaw !== oldRaw) {
      const newClaim = `${token}\n${newRaw}`;
      const replaced = await this.transitions.replaceClaimPayload({
        processingKey: this.keys.processing,
        inflightKey,
        token,
        oldEntry: claim,
        newEntry: newClaim,
        leaseTtlSeconds: LEASE_TTL_SECONDS,
        tenantLeaseKeys: this.keys,
        tenantId: job.tenantId,
      });
      if (!replaced) {
        this.claims.delete(job);
        throw new Error(`review lease lost before job persistence for ${prKey(job)}`);
      }
      const oldMeta = processingMetaKey(this.keys.processingMetaPrefix, claim);
      const newMeta = processingMetaKey(this.keys.processingMetaPrefix, newClaim);
      const startedAt = await this.redis.get(oldMeta);
      if (startedAt !== null) {
        await this.redis.set(newMeta, startedAt, 'EX', PROCESSING_META_TTL_SECONDS);
        await this.redis.del(oldMeta);
      } else {
        await this.redis.set(newMeta, String(Date.now()), 'EX', PROCESSING_META_TTL_SECONDS, 'NX');
      }
      this.claims.set(job, newClaim);
      activeClaim = newClaim;
    } else {
      const refreshed = await this.transitions.refreshOwnedLease({
        inflightKey,
        token,
        leaseTtlSeconds: LEASE_TTL_SECONDS,
        tenantLeaseKeys: this.keys,
        tenantId: job.tenantId,
      });
      if (!refreshed) {
        this.claims.delete(job);
        throw new Error(`review lease lost before job persistence for ${prKey(job)}`);
      }
      const meta = processingMetaKey(this.keys.processingMetaPrefix, activeClaim);
      const startedAt = await this.redis.get(meta);
      await this.redis.set(
        meta,
        startedAt ?? String(Date.now()),
        'EX',
        PROCESSING_META_TTL_SECONDS,
      );
    }
  }

  async markFailed(job: ReviewJobPayload, failure: QueueFailure): Promise<boolean> {
    if (!shouldDeadLetterFailure(failure)) return this.finalize(job, true, 'failed');
    const claim = this.claims.get(job);
    if (!claim || !claim.includes('\n')) return false;
    const record: DeadLetterRecord = {
      id: randomUUID(),
      job: { ...job },
      reason: failure.code,
      failedAt: new Date().toISOString(),
      attempts: (job.attempts ?? 0) + 1,
      error: failure.message,
    };
    const finalized = await this.transitions.deadLetterOwnedClaim({
      inflightKey: `${this.keys.inflightPrefix}${prKey(job)}`,
      processingKey: this.keys.processing,
      processingMetaKey: processingMetaKey(this.keys.processingMetaPrefix, claim),
      seenKey: `${this.keys.seenPrefix}${jobIdempotencyKey(job)}`,
      stateKey: `${this.keys.statePrefix}${jobIdempotencyKey(job)}`,
      deadLettersKey: this.keys.deadLetters,
      token: claimToken(claim),
      processingEntry: claim,
      record: JSON.stringify({ ...record, job: JSON.stringify(record.job) }),
      stateTtlSeconds: STATE_TTL_SECONDS,
      tenantLeaseKeys: this.keys,
    });
    this.claims.delete(job);
    if (finalized)
      this.onOperationalEvent?.({ type: 'dead-lettered', record, source: 'terminal-failure' });
    return finalized;
  }

  async returnToQueue(
    job: ReviewJobPayload,
    opts?: { availableAtMs?: number },
  ): Promise<'newer-pending' | 'requeued' | false> {
    const claim = this.claims.get(job);
    if (!claim || !claim.includes('\n')) return false;
    const returned: ReviewJobPayload = { ...job };
    if (opts?.availableAtMs) returned.availableAtMs = opts.availableAtMs;
    else delete returned.availableAtMs;
    const result = await this.transitions.returnOwnedClaimToQueue({
      inflightKey: `${this.keys.inflightPrefix}${prKey(job)}`,
      processingKey: this.keys.processing,
      processingMetaKey: processingMetaKey(this.keys.processingMetaPrefix, claim),
      stateKey: `${this.keys.statePrefix}${jobIdempotencyKey(job)}`,
      pendingKey: `${this.keys.pendingPrefix}${prKey(job)}`,
      pendingCountKey: this.keys.pendingCount,
      queueKey: this.keys.queue,
      token: claimToken(claim),
      processingEntry: claim,
      jobJson: JSON.stringify(returned),
      stateTtlSeconds: STATE_TTL_SECONDS,
      tenantLeaseKeys: this.keys,
    });
    this.claims.delete(job);
    return result;
  }

  private completedKeys(job: ReviewJobPayload): string[] {
    const idKey = jobIdempotencyKey(job);
    const doneKeys = [`${this.keys.donePrefix}${idKey}`];
    const bare = reviewShaIdempotencyKey(job);
    if (idKey !== bare && (job.kind ?? 'review') === 'review')
      doneKeys.push(`${this.keys.donePrefix}${bare}`);
    return doneKeys;
  }

  private requireClaim(job: ReviewJobPayload, prefix: string): string {
    const claim = this.claims.get(job);
    if (!claim) throw new Error(`review ${prefix} for ${prKey(job)} (claim token missing)`);
    return claim;
  }

  private async finalize(
    job: ReviewJobPayload,
    deleteSeen: boolean,
    state: Extract<QueueJobState, 'succeeded' | 'failed'>,
    doneKeys: string[] = [],
  ): Promise<boolean> {
    const claim = this.claims.get(job);
    if (!claim || !claim.includes('\n')) return false;
    const finalized = await this.transitions.finalizeOwnedClaim({
      inflightKey: `${this.keys.inflightPrefix}${prKey(job)}`,
      processingKey: this.keys.processing,
      processingMetaKey: processingMetaKey(this.keys.processingMetaPrefix, claim),
      seenKey: `${this.keys.seenPrefix}${jobIdempotencyKey(job)}`,
      stateKey: `${this.keys.statePrefix}${jobIdempotencyKey(job)}`,
      doneKeys,
      token: claimToken(claim),
      processingEntry: claim,
      deleteSeen,
      state,
      stateTtlSeconds: STATE_TTL_SECONDS,
      tenantLeaseKeys: this.keys,
    });
    this.claims.delete(job);
    return finalized;
  }
}
