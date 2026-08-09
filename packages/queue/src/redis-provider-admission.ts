import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { ProviderAdmission } from './provider-admission.js';

const PROVIDER_LEASE_TTL_MS = 960_000;

const ACQUIRE_LEASE = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[2]) then return false end
redis.call('ZADD', KEYS[1], tonumber(ARGV[1]) + tonumber(ARGV[3]), ARGV[4])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[3]) + 60000)
return ARGV[4]`;

const EXTEND_COOLDOWN = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local requested = tonumber(ARGV[1])
if requested > current then
  redis.call('SET', KEYS[1], requested)
  redis.call('PEXPIREAT', KEYS[1], requested)
  return requested
end
return current`;

export interface RedisProviderAdmissionOptions {
  namespace: string;
  /** Maximum wait for a slot. Defaults to 30 seconds. */
  waitMs?: number;
  now?: () => number;
  random?: () => number;
}

/**
 * The only Redis-aware provider scheduler. Queue lifecycle code never needs
 * provider key names or Lua scripts, and admission failures cannot mutate job
 * ownership state.
 */
export class RedisProviderAdmission implements ProviderAdmission {
  private readonly leasePrefix: string;
  private readonly cooldownPrefix: string;
  private readonly waitMs: number | undefined;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(
    private readonly redis: Redis,
    options: RedisProviderAdmissionOptions,
  ) {
    const prefix = `${options.namespace}:`;
    this.leasePrefix = `${prefix}provider-leases:`;
    this.cooldownPrefix = `${prefix}provider-cooldown:`;
    this.waitMs = Math.min(3_600_000, Math.max(1_000, Math.floor(options.waitMs ?? 30_000)));
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  async acquireProviderLease(
    provider: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<string> {
    const token = randomUUID();
    const deadline = this.waitMs === undefined ? undefined : this.now() + this.waitMs;
    const key = this.key(this.leasePrefix, provider);
    for (;;) {
      if (signal?.aborted) throw new Error('review cancelled while waiting for provider lease');
      const acquired = await this.redis.eval(
        ACQUIRE_LEASE,
        1,
        key,
        this.now(),
        Math.max(1, Math.floor(limit)),
        PROVIDER_LEASE_TTL_MS,
        token,
      );
      if (acquired === token) return token;
      if (deadline !== undefined && this.now() >= deadline) {
        throw new Error(
          `429 provider ${provider} distributed concurrency saturated; retry-after: 1`,
        );
      }
      await waitForSlot(100 + Math.floor(this.random() * 150), signal);
    }
  }

  async releaseProviderLease(provider: string, token: string): Promise<void> {
    await this.redis.zrem(this.key(this.leasePrefix, provider), token);
  }

  async getProviderCooldownMs(provider: string): Promise<number> {
    const raw = await this.redis.get(this.key(this.cooldownPrefix, provider));
    const until = Number(raw);
    return Number.isFinite(until) ? Math.max(0, until - this.now()) : 0;
  }

  async setProviderCooldown(provider: string, durationMs: number): Promise<void> {
    const until = this.now() + Math.min(300_000, Math.max(250, Math.floor(durationMs)));
    await this.redis.eval(EXTEND_COOLDOWN, 1, this.key(this.cooldownPrefix, provider), until);
  }

  private key(prefix: string, provider: string): string {
    const safe = provider
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return `${prefix}${safe || 'unknown'}`;
  }
}

function waitForSlot(durationMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, durationMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new Error('review cancelled while waiting for provider lease'));
    };
    function done(): void {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}
