import { randomUUID } from 'node:crypto';

/**
 * Distributed admission control for model providers. This is intentionally
 * separate from durable review-job state: provider saturation must never alter
 * queue ownership, deduplication, or recovery semantics.
 */
export interface AcquireProviderLeaseOptions {
  /** Cap wait for this attempt; defaults to the adapter's configured wait. */
  waitMs?: number;
  /**
   * Added to the waiter enqueue score. Negative values prefer stragglers /
   * already-running reviews ahead of brand-new waiters.
   */
  priorityBiasMs?: number;
}

export interface ProviderAdmission {
  acquireProviderLease(
    provider: string,
    limit: number,
    signal?: AbortSignal,
    options?: AcquireProviderLeaseOptions,
  ): Promise<string>;
  releaseProviderLease(provider: string, token: string): Promise<void>;
  /** Refresh an in-use lease TTL so long paid calls outlive the base lease. */
  renewProviderLease?(provider: string, token: string): Promise<boolean>;
  getProviderCooldownMs(provider: string): Promise<number>;
  setProviderCooldown(provider: string, durationMs: number): Promise<void>;
  /** Optional occupancy peek for adaptive per-review fanout under load. */
  getProviderLoad?(provider: string): Promise<{ active: number; limit: number }>;
}

/**
 * Immutable capacity plan established by the scheduler in Redis before worker
 * processes accept paid provider calls. The epoch makes a planned capacity
 * change explicit instead of allowing a rolling worker deploy to mix limits.
 */
export interface ProviderCapacityPlan {
  readonly epoch: string;
  readonly limits: Readonly<Record<string, number>>;
  /**
   * Whole-fleet concurrent review limit for one tenant. This is deliberately
   * separate from provider slots: it keeps a busy workspace from taking every
   * worker while still allowing each provider to use its own global ceiling.
   * Omitted only for legacy/direct queue construction.
   */
  readonly tenantConcurrency?: number;
}

/** Optional capability implemented by distributed admission adapters. */
export interface ProviderCapacityRegistry {
  initializeProviderCapacities(): Promise<void>;
  assertProviderCapacitiesReady(): Promise<void>;
}

/** A queue backend that exposes its independent provider-admission adapter. */
export interface ProviderAdmissionOwner {
  readonly providerAdmission: ProviderAdmission;
}

export function providerAdmissionFor(value: unknown): ProviderAdmission | null {
  if (
    typeof value === 'object' &&
    value !== null &&
    'providerAdmission' in value &&
    isProviderAdmission((value as { providerAdmission?: unknown }).providerAdmission)
  ) {
    return (value as ProviderAdmissionOwner).providerAdmission;
  }
  return null;
}

/** Discover the optional scheduler/worker fleet-capacity capability safely. */
export function providerCapacityRegistryFor(value: unknown): ProviderCapacityRegistry | null {
  const admission = providerAdmissionFor(value);
  if (
    admission &&
    typeof (admission as Partial<ProviderCapacityRegistry>).initializeProviderCapacities ===
      'function' &&
    typeof (admission as Partial<ProviderCapacityRegistry>).assertProviderCapacitiesReady ===
      'function'
  ) {
    return admission as ProviderAdmission & ProviderCapacityRegistry;
  }
  return null;
}

function isProviderAdmission(value: unknown): value is ProviderAdmission {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ProviderAdmission).acquireProviderLease === 'function' &&
    typeof (value as ProviderAdmission).releaseProviderLease === 'function' &&
    typeof (value as ProviderAdmission).getProviderCooldownMs === 'function' &&
    typeof (value as ProviderAdmission).setProviderCooldown === 'function'
  );
}

interface MemoryLease {
  provider: string;
  expiresAt: number;
}

interface MemoryWaiter {
  id: string;
  provider: string;
  enqueuedAt: number;
  wake: () => void;
}

export interface MemoryProviderAdmissionState {
  leases: Map<string, MemoryLease>;
  cooldowns: Map<string, number>;
  limits?: Map<string, number>;
  waiters?: MemoryWaiter[];
}

export interface MemoryProviderAdmissionOptions {
  /** Share this object between queues to model multi-worker coordination. */
  state?: MemoryProviderAdmissionState;
  /** Injectable clock makes saturation/cooldown tests deterministic. */
  now?: () => number;
  /** Bounded polling interval for test and development backends. */
  retryDelayMs?: number;
  /** Maximum wait; defaults to 30 seconds so provider saturation cannot hold a worker forever. */
  waitMs?: number;
  leaseTtlMs?: number;
}

/**
 * No-I/O implementation used by local development and black-box contracts.
 * A caller can inject one shared state object into many queues to reproduce
 * process-level provider caps without a live Redis instance.
 */
export class MemoryProviderAdmission implements ProviderAdmission {
  private readonly state: MemoryProviderAdmissionState;
  private readonly now: () => number;
  private readonly retryDelayMs: number;
  private readonly waitMs: number;
  private readonly leaseTtlMs: number;

  constructor(options: MemoryProviderAdmissionOptions = {}) {
    this.state = options.state ?? {
      leases: new Map(),
      cooldowns: new Map(),
      limits: new Map(),
      waiters: [],
    };
    if (!this.state.limits) this.state.limits = new Map();
    if (!this.state.waiters) this.state.waiters = [];
    this.now = options.now ?? Date.now;
    this.retryDelayMs = Math.max(1, Math.floor(options.retryDelayMs ?? 5));
    this.waitMs = Math.max(1_000, Math.floor(options.waitMs ?? 30_000));
    this.leaseTtlMs = Math.max(1, Math.floor(options.leaseTtlMs ?? 960_000));
  }

  async acquireProviderLease(
    provider: string,
    limit: number,
    signal?: AbortSignal,
    options?: AcquireProviderLeaseOptions,
  ): Promise<string> {
    const normalized = normalizeProviderName(provider);
    const ceiling = Math.max(1, Math.floor(limit));
    this.state.limits?.set(normalized, ceiling);
    const token = randomUUID();
    const waiterId = randomUUID();
    const waitMs = Math.min(3_600_000, Math.max(1, Math.floor(options?.waitMs ?? this.waitMs)));
    const deadline = this.now() + waitMs;
    const priorityBiasMs = Math.floor(options?.priorityBiasMs ?? 0);
    const waiter: MemoryWaiter = {
      id: waiterId,
      provider: normalized,
      enqueuedAt: this.now() + priorityBiasMs,
      wake: () => {},
    };
    this.state.waiters!.push(waiter);
    try {
      for (;;) {
        if (signal?.aborted) throw new Error('review cancelled while waiting for provider lease');
        this.removeExpiredLeases(normalized);
        const free = ceiling - this.activeLeaseCount(normalized);
        const ordered = this.state
          .waiters!.filter((entry) => entry.provider === normalized)
          .sort(
            (left, right) => left.enqueuedAt - right.enqueuedAt || left.id.localeCompare(right.id),
          );
        const rank = ordered.findIndex((entry) => entry.id === waiterId);
        if (free > 0 && rank >= 0 && rank < free) {
          this.state.leases.set(token, {
            provider: normalized,
            expiresAt: this.now() + this.leaseTtlMs,
          });
          return token;
        }
        const remaining = deadline - this.now();
        if (remaining <= 0) {
          throw new Error(
            `429 provider ${normalized} distributed concurrency saturated; retry-after: ${this.retryAfterSeconds(normalized)}`,
          );
        }
        await this.waitForAdmissionWake(waiter, Math.min(this.retryDelayMs, remaining), signal);
      }
    } finally {
      this.state.waiters = this.state.waiters!.filter((entry) => entry.id !== waiterId);
    }
  }

  async renewProviderLease(provider: string, token: string): Promise<boolean> {
    const current = this.state.leases.get(token);
    if (!current || current.provider !== normalizeProviderName(provider)) return false;
    if (current.expiresAt <= this.now()) {
      this.state.leases.delete(token);
      return false;
    }
    current.expiresAt = this.now() + this.leaseTtlMs;
    return true;
  }

  async releaseProviderLease(provider: string, token: string): Promise<void> {
    const current = this.state.leases.get(token);
    if (current?.provider === normalizeProviderName(provider)) this.state.leases.delete(token);
    const normalized = normalizeProviderName(provider);
    for (const waiter of this.state.waiters!) {
      if (waiter.provider === normalized) waiter.wake();
    }
  }

  async getProviderCooldownMs(provider: string): Promise<number> {
    const key = normalizeProviderName(provider);
    const until = this.state.cooldowns.get(key) ?? 0;
    if (until <= this.now()) {
      this.state.cooldowns.delete(key);
      return 0;
    }
    return until - this.now();
  }

  async setProviderCooldown(provider: string, durationMs: number): Promise<void> {
    const key = normalizeProviderName(provider);
    const until = this.now() + Math.min(300_000, Math.max(250, Math.floor(durationMs)));
    this.state.cooldowns.set(key, Math.max(this.state.cooldowns.get(key) ?? 0, until));
  }

  async getProviderLoad(provider: string): Promise<{ active: number; limit: number }> {
    const normalized = normalizeProviderName(provider);
    this.removeExpiredLeases(normalized);
    const active = this.activeLeaseCount(normalized);
    const configured = this.state.limits?.get(normalized);
    return {
      active,
      limit: Math.max(1, configured ?? active),
    };
  }

  private retryAfterSeconds(provider: string): number {
    let oldest = Number.POSITIVE_INFINITY;
    for (const lease of this.state.leases.values()) {
      if (lease.provider === provider) oldest = Math.min(oldest, lease.expiresAt);
    }
    if (!Number.isFinite(oldest)) return 1;
    return Math.max(1, Math.ceil((oldest - this.now()) / 1000));
  }

  private activeLeaseCount(provider: string): number {
    let count = 0;
    for (const lease of this.state.leases.values()) if (lease.provider === provider) count += 1;
    return count;
  }

  private removeExpiredLeases(provider: string): void {
    const now = this.now();
    for (const [token, lease] of this.state.leases) {
      if (lease.provider === provider && lease.expiresAt <= now) this.state.leases.delete(token);
    }
  }

  private waitForAdmissionWake(
    waiter: MemoryWaiter,
    durationMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(done, durationMs);
      const onAbort = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(new Error('review cancelled while waiting for provider lease'));
      };
      waiter.wake = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      function done(): void {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }
}

export function normalizeProviderName(provider: string): string {
  const normalized = provider
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'unknown';
}

/** Strip per-key lane suffix (`luna-k0` → `luna`) for fleet capacity lookups. */
export function baseProviderName(provider: string): string {
  return normalizeProviderName(provider).replace(/-k\d+$/, '') || 'unknown';
}

/** True when every named provider is at its active lease ceiling. */
export async function providersSaturated(
  admission: ProviderAdmission,
  providers: readonly string[],
): Promise<boolean> {
  if (!admission.getProviderLoad || providers.length === 0) return false;
  const loads = await Promise.all(
    providers.map(async (provider) => {
      try {
        return await admission.getProviderLoad!(provider);
      } catch {
        return null;
      }
    }),
  );
  const known = loads.filter((load): load is { active: number; limit: number } => load !== null);
  if (known.length === 0) return false;
  return known.every((load) => load.active >= load.limit);
}
