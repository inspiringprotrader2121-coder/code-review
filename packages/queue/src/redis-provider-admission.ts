import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import {
  normalizeProviderName,
  type ProviderAdmission,
  type ProviderCapacityPlan,
  type ProviderCapacityRegistry,
} from './provider-admission.js';

export const FLEET_TENANT_CONCURRENCY_FIELD = 'tenant-concurrency';

/** Keep the scheduler registry key shared by provider and tenant admission. */
export function fleetCapacityRegistryKey(namespace: string, epoch: string): string {
  return `${namespace}:provider-capacity:${epoch}`;
}

const PROVIDER_LEASE_TTL_MS = 960_000;

const ACQUIRE_LEASE = `
local limit = tonumber(ARGV[2])
if #KEYS == 2 then
  local configured = redis.call('HGET', KEYS[2], ARGV[5])
  if not configured then return {'capacity_missing', ARGV[5]} end
  if tonumber(configured) ~= limit then
    return {'capacity_mismatch', ARGV[5], configured, ARGV[2]}
  end
  limit = tonumber(configured)
end
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
if redis.call('ZCARD', KEYS[1]) >= limit then return false end
redis.call('ZADD', KEYS[1], tonumber(ARGV[1]) + tonumber(ARGV[3]), ARGV[4])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[3]) + 60000)
return ARGV[4]`;

const REGISTER_CAPACITY_PLAN = `
for index = 1, #ARGV, 2 do
  local current = redis.call('HGET', KEYS[1], ARGV[index])
  if current and tonumber(current) ~= tonumber(ARGV[index + 1]) then
    return {'capacity_mismatch', ARGV[index], current, ARGV[index + 1]}
  end
end
for index = 1, #ARGV, 2 do
  redis.call('HSETNX', KEYS[1], ARGV[index], ARGV[index + 1])
end
return {'ok'}`;

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
  /** Scheduler-owned, Redis-registered fleet capacity. Omit for legacy/local use. */
  capacityPlan?: ProviderCapacityPlan;
}

/**
 * The only Redis-aware provider scheduler. Queue lifecycle code never needs
 * provider key names or Lua scripts, and admission failures cannot mutate job
 * ownership state.
 */
export class RedisProviderAdmission implements ProviderAdmission, ProviderCapacityRegistry {
  private readonly leasePrefix: string;
  private readonly cooldownPrefix: string;
  private readonly capacityPlan: ProviderCapacityPlan | undefined;
  private readonly capacityKey: string | undefined;
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
    this.capacityPlan = normalizeCapacityPlan(options.capacityPlan);
    this.capacityKey = this.capacityPlan
      ? fleetCapacityRegistryKey(options.namespace, this.capacityPlan.epoch)
      : undefined;
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
    const normalized = normalizeProviderName(provider);
    const configuredLimit = this.capacityPlan?.limits[normalized];
    if (this.capacityPlan && configuredLimit === undefined) {
      throw new Error(
        `provider ${normalized} has no registered fleet capacity in epoch ${this.capacityPlan.epoch}`,
      );
    }
    const capacity = configuredLimit ?? Math.max(1, Math.floor(limit));
    const key = this.key(this.leasePrefix, normalized);
    for (;;) {
      if (signal?.aborted) throw new Error('review cancelled while waiting for provider lease');
      const acquired: unknown = await this.redis.eval(
        ACQUIRE_LEASE,
        this.capacityKey ? 2 : 1,
        key,
        ...(this.capacityKey ? [this.capacityKey] : []),
        this.now(),
        capacity,
        PROVIDER_LEASE_TTL_MS,
        token,
        normalized,
      );
      if (acquired === token) return token;
      if (Array.isArray(acquired))
        throw capacityLeaseError(acquired, normalized, this.capacityPlan);
      if (deadline !== undefined && this.now() >= deadline) {
        throw new Error(
          `429 provider ${normalized} distributed concurrency saturated; retry-after: 1`,
        );
      }
      await waitForSlot(100 + Math.floor(this.random() * 150), signal);
    }
  }

  async releaseProviderLease(provider: string, token: string): Promise<void> {
    await this.redis.zrem(this.key(this.leasePrefix, provider), token);
  }

  async initializeProviderCapacities(): Promise<void> {
    if (!this.capacityPlan || !this.capacityKey) return;
    const response: unknown = await this.redis.eval(
      REGISTER_CAPACITY_PLAN,
      1,
      this.capacityKey,
      ...capacityEntries(this.capacityPlan),
    );
    if (Array.isArray(response) && response[0] === 'ok') return;
    if (response === 'ok') return;
    throw capacityPlanError(response, this.capacityPlan);
  }

  async assertProviderCapacitiesReady(): Promise<void> {
    if (!this.capacityPlan || !this.capacityKey) return;
    const entries = capacityEntries(this.capacityPlan);
    const fields = entries.filter((_, index) => index % 2 === 0);
    const actual = await this.redis.hmget(this.capacityKey, ...fields);
    for (let index = 0; index < fields.length; index += 1) {
      const expected = entries[index * 2 + 1]!;
      const observed = actual[index];
      if (observed === null || observed === undefined) {
        const subject =
          fields[index] === FLEET_TENANT_CONCURRENCY_FIELD
            ? 'tenant fleet capacity'
            : `provider ${fields[index]} fleet capacity`;
        throw new Error(`${subject} is not registered for epoch ${this.capacityPlan.epoch}`);
      }
      if (observed !== expected) {
        const subject =
          fields[index] === FLEET_TENANT_CONCURRENCY_FIELD
            ? 'tenant fleet capacity'
            : `provider ${fields[index]} fleet capacity`;
        throw new Error(
          `${subject} mismatch for epoch ${this.capacityPlan.epoch}: Redis=${observed}, worker=${expected}`,
        );
      }
    }
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
    return `${prefix}${normalizeProviderName(provider)}`;
  }
}

function normalizeCapacityPlan(
  plan: ProviderCapacityPlan | undefined,
): ProviderCapacityPlan | undefined {
  if (!plan) return undefined;
  const epoch = plan.epoch.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(epoch)) {
    throw new Error('provider fleet capacity epoch must be 1-64 safe characters');
  }
  const limits: Record<string, number> = {};
  for (const [provider, value] of Object.entries(plan.limits)) {
    const normalized = normalizeProviderName(provider);
    if (normalized === 'unknown')
      throw new Error('provider fleet capacity names must be non-empty');
    const limit = Number(value);
    if (!Number.isFinite(limit) || limit < 1 || limit > 10_000) {
      throw new Error(`provider ${normalized} fleet capacity must be an integer from 1 to 10000`);
    }
    const rounded = Math.floor(limit);
    if (limits[normalized] !== undefined && limits[normalized] !== rounded) {
      throw new Error(`provider ${normalized} fleet capacity is configured more than once`);
    }
    limits[normalized] = rounded;
  }
  if (Object.keys(limits).length === 0)
    throw new Error('provider fleet capacity plan cannot be empty');
  const tenantConcurrency =
    plan.tenantConcurrency === undefined ? undefined : Number(plan.tenantConcurrency);
  if (
    tenantConcurrency !== undefined &&
    (!Number.isFinite(tenantConcurrency) || tenantConcurrency < 1 || tenantConcurrency > 10_000)
  ) {
    throw new Error('fleet tenant concurrency must be an integer from 1 to 10000');
  }
  return Object.freeze({
    epoch,
    limits: Object.freeze(limits),
    ...(tenantConcurrency === undefined
      ? {}
      : { tenantConcurrency: Math.floor(tenantConcurrency) }),
  });
}

function capacityEntries(plan: ProviderCapacityPlan): string[] {
  const providers = Object.entries(plan.limits)
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([provider, limit]) => [provider, String(limit)]);
  return plan.tenantConcurrency === undefined
    ? providers
    : [...providers, FLEET_TENANT_CONCURRENCY_FIELD, String(plan.tenantConcurrency)];
}

function capacityPlanError(response: unknown, plan: ProviderCapacityPlan): Error {
  if (Array.isArray(response) && response[0] === 'capacity_mismatch') {
    return new Error(
      `provider ${String(response[1])} fleet capacity mismatch for epoch ${plan.epoch}: Redis=${String(response[2])}, scheduler=${String(response[3])}`,
    );
  }
  return new Error(`could not initialize provider fleet capacity epoch ${plan.epoch}`);
}

function capacityLeaseError(
  response: unknown[],
  provider: string,
  plan: ProviderCapacityPlan | undefined,
): Error {
  if (response[0] === 'capacity_missing') {
    return new Error(
      `provider ${provider} fleet capacity is not registered${plan ? ` for epoch ${plan.epoch}` : ''}`,
    );
  }
  if (response[0] === 'capacity_mismatch') {
    return new Error(
      `provider ${provider} fleet capacity mismatch${plan ? ` for epoch ${plan.epoch}` : ''}: Redis=${String(response[2])}, worker=${String(response[3])}`,
    );
  }
  return new Error(`provider ${provider} fleet capacity admission failed`);
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
