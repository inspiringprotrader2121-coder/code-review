import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { RELEASE_RECOVERY_LEASE_LUA } from './redis-scripts.js';
import { RECOVERY_LEASE_TTL_MS, type RedisQueueKeys } from './redis-keys.js';
import type { QueueDepth } from './types.js';
import type { QueueJobState } from './state-machine.js';

/** Readiness, lifecycle state, depth, and recovery-leader diagnostics. */
export class RedisQueueDiagnostics {
  constructor(
    private readonly redis: Redis,
    private readonly keys: RedisQueueKeys,
  ) {}

  async acquireRecoveryLease(): Promise<string | null> {
    const token = randomUUID();
    const acquired = await this.redis.set(
      this.keys.recoveryLease,
      token,
      'PX',
      RECOVERY_LEASE_TTL_MS,
      'NX',
    );
    return acquired === 'OK' ? token : null;
  }

  async releaseRecoveryLease(token: string): Promise<void> {
    await this.redis.eval(RELEASE_RECOVERY_LEASE_LUA, 1, this.keys.recoveryLease, token);
  }

  async getJobState(jobId: string): Promise<QueueJobState | null> {
    const state = await this.redis.get(`${this.keys.statePrefix}${jobId}`);
    return state === 'submitted' ||
      state === 'ready' ||
      state === 'claimed' ||
      state === 'running' ||
      state === 'succeeded' ||
      state === 'failed' ||
      state === 'cancelled' ||
      state === 'dead-lettered'
      ? state
      : null;
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.redis.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  async depth(): Promise<QueueDepth> {
    const queued = await this.redis.llen(this.keys.queue);
    const inFlight = await this.redis.llen(this.keys.processing);
    const waitingOnPr = Math.max(0, Number(await this.redis.get(this.keys.pendingCount)) || 0);
    let oldestQueuedAt: string | null = null;
    if (queued > 0) {
      const head = await this.redis.lindex(this.keys.queue, 0);
      if (head) {
        try {
          oldestQueuedAt = (JSON.parse(head) as { enqueuedAt?: string }).enqueuedAt ?? null;
        } catch {
          /* corrupt entries are not diagnostics */
        }
      }
    }
    return { queued, waitingOnPr, inFlight, oldestQueuedAt };
  }
}
