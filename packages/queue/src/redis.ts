import { Redis } from 'ioredis';
import {
  type DeadLetterRecord,
  type EnqueueResult,
  type MarkCompletedOptions,
  type QueueDepth,
  type QueueFailure,
  type QueueOperationalEvent,
  type ReviewJobPayload,
  type ReviewQueue,
} from './types.js';
import type { QueueJobState } from './state-machine.js';
import type { ProviderAdmission, ProviderCapacityPlan } from './provider-admission.js';
import { RedisProviderAdmission } from './redis-provider-admission.js';
import { createRedisTenantAdmission } from './redis-tenant-admission.js';
import { RedisQueueTransitionRepository } from './redis-transitions.js';
import { RedisEnqueueOperations } from './redis-enqueue.js';
import { RedisLeaseOperations } from './redis-lease.js';
import { RedisRecoveryOperations } from './redis-recovery.js';
import { RedisQueueDiagnostics } from './redis-diagnostics.js';
import { createRedisQueueKeys, validateRedisQueueNamespace } from './redis-keys.js';

// Crash-loop and spend guard for startup recovery: a claimed review may already
// have paid for several provider stages. Operators may explicitly opt into a
// bounded resume count once durable stage checkpoints exist.
export interface RedisReviewQueueOptions {
  maxResumeAfterRestart?: number;
  /** Redis key namespace. Tests and parallel installations must use distinct values. */
  namespace?: string;
  /** Maximum wait for a distributed provider slot. Defaults to 30 seconds. */
  providerLeaseWaitMs?: number;
  /** Supply an independently constructed adapter in tests or composition roots. */
  providerAdmission?: ProviderAdmission;
  /** Scheduler-established provider capacity used by every worker in a fleet. */
  providerCapacityPlan?: ProviderCapacityPlan;
}

/**
 * Stable queue facade. Redis data mechanics live in focused internal modules:
 * keys/scripts, arrival/coalescing, token-fenced leases, recovery, and
 * diagnostics. Keeping this class thin preserves existing composition APIs.
 */
export class RedisReviewQueue implements ReviewQueue {
  readonly providerAdmission: ProviderAdmission;
  private readonly enqueueOperations: RedisEnqueueOperations;
  private readonly leaseOperations: RedisLeaseOperations;
  private readonly recoveryOperations: RedisRecoveryOperations;
  private readonly diagnostics: RedisQueueDiagnostics;
  private readonly lockTokens = new WeakMap<ReviewJobPayload, string>();
  private readonly operationalEvents: QueueOperationalEvent[] = [];

  constructor(url: string, options: RedisReviewQueueOptions = {}) {
    const namespace = validateRedisQueueNamespace(options.namespace);
    const redis = new Redis(url);
    const keys = createRedisQueueKeys(namespace);
    const tenantAdmission = createRedisTenantAdmission(namespace, options.providerCapacityPlan);
    const transitions = new RedisQueueTransitionRepository(redis);
    const configured = options.maxResumeAfterRestart ?? 0;
    const maxResumeAfterRestart =
      Number.isFinite(configured) && configured >= 0 ? Math.min(Math.floor(configured), 10) : 0;
    this.providerAdmission =
      options.providerAdmission ??
      new RedisProviderAdmission(redis, {
        namespace,
        waitMs: options.providerLeaseWaitMs,
        capacityPlan: options.providerCapacityPlan,
      });
    this.enqueueOperations = new RedisEnqueueOperations(
      redis,
      keys,
      this.lockTokens,
      tenantAdmission,
    );
    const recordOperationalEvent = (event: QueueOperationalEvent): void => {
      this.operationalEvents.push(event);
    };
    this.leaseOperations = new RedisLeaseOperations(
      redis,
      keys,
      transitions,
      this.lockTokens,
      recordOperationalEvent,
    );
    this.recoveryOperations = new RedisRecoveryOperations(
      redis,
      keys,
      transitions,
      maxResumeAfterRestart,
      recordOperationalEvent,
    );
    this.diagnostics = new RedisQueueDiagnostics(redis, keys);
    this.redis = redis;
  }

  private readonly redis: Redis;

  /** @deprecated Inject `providerAdmission` separately. */
  acquireProviderLease(provider: string, limit: number, signal?: AbortSignal): Promise<string> {
    return this.providerAdmission.acquireProviderLease(provider, limit, signal);
  }

  /** @deprecated Inject `providerAdmission` separately. */
  releaseProviderLease(provider: string, token: string): Promise<void> {
    return this.providerAdmission.releaseProviderLease(provider, token);
  }

  /** @deprecated Inject `providerAdmission` separately. */
  getProviderCooldownMs(provider: string): Promise<number> {
    return this.providerAdmission.getProviderCooldownMs(provider);
  }

  /** @deprecated Inject `providerAdmission` separately. */
  setProviderCooldown(provider: string, durationMs: number): Promise<void> {
    return this.providerAdmission.setProviderCooldown(provider, durationMs);
  }

  enqueue(job: ReviewJobPayload): Promise<EnqueueResult> {
    return this.enqueueOperations.enqueue(job);
  }

  dequeue(): Promise<ReviewJobPayload | null> {
    return this.enqueueOperations.dequeue();
  }

  markCompleted(job: ReviewJobPayload, options?: MarkCompletedOptions): Promise<boolean> {
    return this.leaseOperations.markCompleted(job, options);
  }

  renewLease(job: ReviewJobPayload): Promise<void> {
    return this.leaseOperations.renewLease(job);
  }

  markRunning(job: ReviewJobPayload): Promise<boolean> {
    return this.leaseOperations.markRunning(job);
  }

  persistJob(job: ReviewJobPayload): Promise<void> {
    return this.leaseOperations.persistJob(job);
  }

  markFailed(job: ReviewJobPayload, failure: QueueFailure): Promise<boolean> {
    return this.leaseOperations.markFailed(job, failure);
  }

  releaseLockAndDrain(prKey: string): Promise<ReviewJobPayload | null> {
    return this.enqueueOperations.releaseLockAndDrain(prKey);
  }

  recoverOrphans(): Promise<number> {
    return this.recoveryOperations.recoverOrphans();
  }

  listDeadLetters(limit?: number): Promise<DeadLetterRecord[]> {
    return this.recoveryOperations.listDeadLetters(limit);
  }

  replayDeadLetter(id: string): Promise<boolean> {
    return this.recoveryOperations.replayDeadLetter(id);
  }

  drainOperationalEvents(): QueueOperationalEvent[] {
    return this.operationalEvents.splice(0);
  }

  acquireRecoveryLease(): Promise<string | null> {
    return this.diagnostics.acquireRecoveryLease();
  }

  releaseRecoveryLease(token: string): Promise<void> {
    return this.diagnostics.releaseRecoveryLease(token);
  }

  getJobState(jobId: string): Promise<QueueJobState | null> {
    return this.diagnostics.getJobState(jobId);
  }

  ping(): Promise<boolean> {
    return this.diagnostics.ping();
  }

  depth(): Promise<QueueDepth> {
    return this.diagnostics.depth();
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}
