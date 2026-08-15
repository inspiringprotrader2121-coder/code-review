import { AsyncLocalStorage } from 'node:async_hooks';
import { resolveProviderConcurrency } from '../runtime-limits.js';
import type { LlmClientOptions, LlmProviderCoordinator } from './contracts.js';
import { ReviewCancelledError, throwIfCancelled } from './cancellation.js';
import { isRetryableRateLimit, providerCooldownForFailure, sleep } from './retry-policy.js';
import { providerName } from './support.js';
import { localProviderTpm, type TpmReserveInput } from './tpm-window.js';

let providerCoordinator: LlmProviderCoordinator | undefined;
let configuredProviderConcurrency: ((provider: string) => number) | undefined;
/** Fallback when coordinator is not configured (tests). Production always
 *  injects ORVEX_PROVIDER_LEASE_WAIT_MS via composeApplication. */
let configuredAdmissionWaitMs = 30_000;
const localProviderCooldownUntil = new Map<string, number>();
const PROVIDER_LEASE_HEARTBEAT_MS = 60_000;
/** Prefer mid-review callers ahead of brand-new waiters by up to one hour. */
const STRAGGLER_PRIORITY_BIAS_MS = -60_000;

const admissionPriority = new AsyncLocalStorage<{ priorityBiasMs: number }>();

interface LlmSlotWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  timer?: ReturnType<typeof setTimeout>;
}
interface ProviderGate {
  active: number;
  waiters: LlmSlotWaiter[];
}
const providerGates = new Map<string, ProviderGate>();

export function configureLlmProviderCoordinator(
  coordinator?: LlmProviderCoordinator,
  localProviderConcurrency?: (provider: string) => number,
  admissionWaitMs?: number,
): void {
  providerCoordinator = coordinator;
  configuredProviderConcurrency = localProviderConcurrency;
  if (admissionWaitMs !== undefined) {
    configuredAdmissionWaitMs = Math.min(3_600_000, Math.max(1_000, Math.floor(admissionWaitMs)));
  } else {
    configuredAdmissionWaitMs = 30_000;
  }
}
export function currentProviderCoordinator(): LlmProviderCoordinator | undefined {
  return providerCoordinator;
}
export function providerAdmissionWaitMs(): number {
  return configuredAdmissionWaitMs;
}
export function providerConcurrency(provider: string, env?: NodeJS.ProcessEnv): number {
  if (env === undefined && configuredProviderConcurrency)
    return configuredProviderConcurrency(provider);
  return resolveProviderConcurrency(provider, env);
}

/** Mid-review paid calls get fair-queue priority over brand-new admissions. */
export function runWithProviderAdmissionPriority<T>(
  priority: 'normal' | 'straggler',
  fn: () => Promise<T>,
): Promise<T> {
  return admissionPriority.run(
    { priorityBiasMs: priority === 'straggler' ? STRAGGLER_PRIORITY_BIAS_MS : 0 },
    fn,
  );
}

export function providerBucketForTarget(
  opts: Pick<LlmClientOptions, 'model' | 'baseUrl' | 'api'>,
): string {
  const identity = `${opts.model} ${opts.baseUrl ?? ''}`.toLowerCase();
  if (identity.includes('luna') || identity.includes('api.openai.com')) return 'luna';
  if (identity.includes('deepseek')) return 'deepseek';
  if (identity.includes('minimax')) return 'minimax';
  return providerName(opts.baseUrl, opts.api)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-');
}

/** Split comma-separated API keys. Empty segments and duplicates are dropped. */
export function splitApiKeys(apiKey: string): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const key of apiKey.split(',').map((part) => part.trim())) {
    if (!key || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

/**
 * Per-key cooldown + local-gate lane. Fleet Redis leases stay on `provider` so
 * fair waiters and capacity epochs remain correct; TPM 429s cool only this lane.
 */
export function providerKeyLane(provider: string, keyIndex: number, keyCount: number): string {
  if (keyCount <= 1) return provider;
  const index = Math.max(0, Math.floor(keyIndex));
  return `${provider}:k${index}`;
}

export interface ProviderTpmPolicy {
  budget: number;
  reserveTokens: number;
  windowMs: number;
  reservationId: string;
  reserveTtlMs?: number;
}

export interface ProviderKeySelection {
  apiKey: string;
  keyIndex: number;
  lane: string;
  cooldownMs: number;
  tpmReserved?: boolean;
  tpmUsed?: number;
  reservationId?: string;
}

/**
 * Prefer a cool key under the TPM budget (round-robin from cursor). If every
 * key is cooling or over budget, return the least-loaded cool lane without a
 * reservation so the caller can wait for the rolling minute to drain.
 */
export async function selectProviderKey(
  provider: string,
  keys: readonly string[],
  cursor: number,
  coordinator: LlmProviderCoordinator | undefined = providerCoordinator,
  tpm?: ProviderTpmPolicy,
): Promise<ProviderKeySelection> {
  if (keys.length === 0) throw new Error('LLM API key is required');
  const lanes = keys.map((_, index) => providerKeyLane(provider, index, keys.length));
  const cooldowns = await Promise.all(
    lanes.map((lane) => getProviderCooldownMs(lane, coordinator)),
  );
  const start = ((cursor % keys.length) + keys.length) % keys.length;

  if (tpm) {
    let fallback: ProviderKeySelection | undefined;
    for (let offset = 0; offset < keys.length; offset++) {
      const keyIndex = (start + offset) % keys.length;
      const cooldownMs = cooldowns[keyIndex] ?? 0;
      if (cooldownMs > 0) continue;
      const lane = lanes[keyIndex]!;
      const reserved = await tryReserveProviderTpm(
        {
          lane,
          tokens: tpm.reserveTokens,
          budget: tpm.budget,
          windowMs: tpm.windowMs,
          reservationId: tpm.reservationId,
          reserveTtlMs: tpm.reserveTtlMs,
        },
        coordinator,
      );
      const candidate: ProviderKeySelection = {
        apiKey: keys[keyIndex]!,
        keyIndex,
        lane,
        cooldownMs: 0,
        tpmUsed: reserved.used,
        reservationId: tpm.reservationId,
        tpmReserved: reserved.ok,
      };
      if (reserved.ok) return candidate;
      if (!fallback || reserved.used < (fallback.tpmUsed ?? Number.POSITIVE_INFINITY)) {
        fallback = { ...candidate, tpmReserved: false };
      }
    }
    if (fallback) return fallback;
  } else {
    for (let offset = 0; offset < keys.length; offset++) {
      const keyIndex = (start + offset) % keys.length;
      if ((cooldowns[keyIndex] ?? 0) <= 0) {
        return {
          apiKey: keys[keyIndex]!,
          keyIndex,
          lane: lanes[keyIndex]!,
          cooldownMs: 0,
        };
      }
    }
  }

  let best = 0;
  for (let index = 1; index < cooldowns.length; index++) {
    if ((cooldowns[index] ?? 0) < (cooldowns[best] ?? 0)) best = index;
  }
  return {
    apiKey: keys[best]!,
    keyIndex: best,
    lane: lanes[best]!,
    cooldownMs: cooldowns[best] ?? 0,
    tpmReserved: false,
    reservationId: tpm?.reservationId,
  };
}

export async function tryReserveProviderTpm(
  input: TpmReserveInput,
  coordinator: LlmProviderCoordinator | undefined = providerCoordinator,
): Promise<{ ok: boolean; used: number }> {
  if (typeof coordinator?.tryReserveProviderTpm === 'function') {
    return coordinator.tryReserveProviderTpm(input);
  }
  return localProviderTpm.tryReserve(input);
}

export async function commitProviderTpm(
  input: { lane: string; reservationId: string; actualTokens: number; windowMs?: number },
  coordinator: LlmProviderCoordinator | undefined = providerCoordinator,
): Promise<void> {
  if (typeof coordinator?.commitProviderTpm === 'function') {
    await coordinator.commitProviderTpm(input);
    return;
  }
  localProviderTpm.commit(input);
}

export function resetLocalProviderTpm(): void {
  localProviderTpm.reset();
}

function gateFor(provider: string): ProviderGate {
  let gate = providerGates.get(provider);
  if (!gate) {
    gate = { active: 0, waiters: [] };
    providerGates.set(provider, gate);
  }
  return gate;
}
function detach(waiter: LlmSlotWaiter): void {
  if (waiter.timer) clearTimeout(waiter.timer);
  if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort);
}

function tryAcquireLocal(gateName: string, concurrencyProvider: string = gateName): boolean {
  const gate = gateFor(gateName);
  if (gate.active >= providerConcurrency(concurrencyProvider)) return false;
  gate.active++;
  return true;
}

async function acquire(
  gateName: string,
  signal?: AbortSignal,
  waitMs = configuredAdmissionWaitMs,
  concurrencyProvider: string = gateName,
): Promise<void> {
  throwIfCancelled(signal);
  if (tryAcquireLocal(gateName, concurrencyProvider)) return;
  const retryAfterSec = Math.max(1, Math.ceil(waitMs / 1000));
  await new Promise<void>((resolve, reject) => {
    const gate = gateFor(gateName);
    const waiter: LlmSlotWaiter = { resolve, reject, signal };
    if (signal) {
      waiter.onAbort = () => {
        const index = gate.waiters.indexOf(waiter);
        if (index >= 0) gate.waiters.splice(index, 1);
        detach(waiter);
        reject(new ReviewCancelledError());
      };
      signal.addEventListener('abort', waiter.onAbort, { once: true });
    }
    gate.waiters.push(waiter);
    waiter.timer = setTimeout(() => {
      const index = gate.waiters.indexOf(waiter);
      if (index < 0) return;
      gate.waiters.splice(index, 1);
      detach(waiter);
      reject(
        new Error(
          `429 provider ${gateName} local concurrency saturated; retry-after: ${retryAfterSec}`,
        ),
      );
    }, waitMs);
    waiter.timer.unref?.();
    if (signal?.aborted) waiter.onAbort?.();
  });
}
function release(provider: string): void {
  const gate = gateFor(provider);
  for (;;) {
    const next = gate.waiters.shift();
    if (!next) {
      gate.active = Math.max(0, gate.active - 1);
      return;
    }
    detach(next);
    if (next.signal?.aborted) {
      next.reject(new ReviewCancelledError());
      continue;
    }
    next.resolve();
    return;
  }
}

export async function setProviderCooldown(
  provider: string,
  durationMs: number,
  coordinator: LlmProviderCoordinator | undefined = providerCoordinator,
): Promise<void> {
  const bounded = Math.min(300_000, Math.max(250, Math.floor(durationMs)));
  localProviderCooldownUntil.set(
    provider,
    Math.max(localProviderCooldownUntil.get(provider) ?? 0, Date.now() + bounded),
  );
  if (coordinator) await coordinator.setProviderCooldown(provider, bounded);
}
export async function getProviderCooldownMs(
  provider: string,
  coordinator: LlmProviderCoordinator | undefined = providerCoordinator,
): Promise<number> {
  const local = Math.max(0, (localProviderCooldownUntil.get(provider) ?? 0) - Date.now());
  const distributed = coordinator ? await coordinator.getProviderCooldownMs(provider) : 0;
  return Math.max(local, distributed);
}

async function waitOutProviderCooldown(
  provider: string,
  signal: AbortSignal | undefined,
  coordinator: LlmProviderCoordinator | undefined,
  deadlineMs: number,
): Promise<void> {
  let announced = false;
  for (;;) {
    throwIfCancelled(signal);
    const cooldownMs = await getProviderCooldownMs(provider, coordinator);
    if (cooldownMs <= 0) {
      if (announced) console.log(`[llm] provider ${provider} cooldown cleared`);
      return;
    }
    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) {
      throw new Error(
        `429 provider ${provider} cooldown active; retry-after: ${Math.ceil(cooldownMs / 1000)}`,
      );
    }
    if (!announced) {
      console.warn(
        `[llm] waiting for ${provider} cooldown (${Math.ceil(Math.min(cooldownMs, remainingMs) / 1000)}s) before paid call`,
      );
      announced = true;
    }
    await sleep(Math.min(cooldownMs, remainingMs, 1_000), signal);
  }
}

function admissionPriorityBiasMs(): number {
  return admissionPriority.getStore()?.priorityBiasMs ?? 0;
}

function saturationRetryAfterSeconds(deadlineMs: number): number {
  return Math.max(1, Math.ceil(Math.max(0, deadlineMs - Date.now()) / 1000) || 1);
}

async function acquireDistributedLease(
  provider: string,
  coordinator: LlmProviderCoordinator,
  signal: AbortSignal | undefined,
  deadlineMs: number,
): Promise<string> {
  const remainingMs = Math.max(1, deadlineMs - Date.now());
  return coordinator.acquireProviderLease(provider, providerConcurrency(provider), signal, {
    waitMs: remainingMs,
    priorityBiasMs: admissionPriorityBiasMs(),
  });
}

function startLeaseHeartbeat(
  provider: string,
  token: string,
  coordinator: LlmProviderCoordinator,
): () => void {
  if (typeof coordinator.renewProviderLease !== 'function') return () => {};
  const timer = setInterval(() => {
    void coordinator
      .renewProviderLease?.(provider, token)
      .catch((error) =>
        console.warn(
          `[llm] failed to renew distributed ${provider} lease:`,
          (error as Error).message?.slice(0, 120),
        ),
      );
  }, PROVIDER_LEASE_HEARTBEAT_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

export interface ProviderCallSlotOptions {
  /**
   * Per-key cooldown + local-gate lane (`provider:kN`). Fleet Redis leases stay
   * on the base `provider` so fair waiters and capacity epochs remain correct.
   */
  keyLane?: string;
}

/**
 * Paid-call boundary with a single admission deadline across cooldown, Redis,
 * and local gates. Redis leases are not held while blocked on the process-local
 * gate (two-phase), and mid-review callers can claim fair-queue priority.
 *
 * When `keyLane` is set (multi-key), cooldown + local gate isolate that key —
 * sibling keys remain admissible while one key's TPM window recovers.
 */
export async function withProviderCallSlot<T>(
  provider: string,
  fn: () => Promise<T>,
  signal?: AbortSignal,
  coordinator: LlmProviderCoordinator | undefined = providerCoordinator,
  options?: ProviderCallSlotOptions,
): Promise<T> {
  const keyLane = options?.keyLane?.trim() || provider;
  const deadlineMs = Date.now() + configuredAdmissionWaitMs;
  let leaseToken: string | undefined;
  let localHeld = false;
  let stopHeartbeat = () => {};
  try {
    for (;;) {
      throwIfCancelled(signal);
      const remainingMs = deadlineMs - Date.now();
      if (remainingMs <= 0) {
        throw new Error(
          `429 provider ${keyLane} admission timed out; retry-after: ${saturationRetryAfterSeconds(deadlineMs)}`,
        );
      }

      await waitOutProviderCooldown(keyLane, signal, coordinator, deadlineMs);

      if (!coordinator) {
        await acquire(keyLane, signal, Math.max(1, deadlineMs - Date.now()), provider);
        localHeld = true;
        break;
      }

      leaseToken = await acquireDistributedLease(provider, coordinator, signal, deadlineMs);
      const postLeaseCooldownMs = await getProviderCooldownMs(keyLane, coordinator);
      if (postLeaseCooldownMs > 0) {
        await coordinator.releaseProviderLease(provider, leaseToken).catch(() => undefined);
        leaseToken = undefined;
        // Sibling TPM can land between cooldown wait and lease grant — keep
        // waiting inside the shared admission deadline instead of aborting.
        continue;
      }
      if (tryAcquireLocal(keyLane, provider)) {
        localHeld = true;
        break;
      }
      // Two-phase: never hold an active Redis lease while parked on local.
      await coordinator.releaseProviderLease(provider, leaseToken).catch(() => undefined);
      leaseToken = undefined;

      const localWaitMs = Math.max(1, deadlineMs - Date.now());
      await acquire(keyLane, signal, localWaitMs, provider);
      // Speculative local slot proves capacity; drop it before re-entering Redis
      // wait so peers are not starved while we queue fairly for a fleet lease.
      release(keyLane);
    }

    if (leaseToken && coordinator) {
      stopHeartbeat = startLeaseHeartbeat(provider, leaseToken, coordinator);
    }

    try {
      return await fn();
    } catch (error) {
      const durationMs = signal?.aborted
        ? undefined
        : providerCooldownForFailure((error as Error)?.message ?? String(error));
      if (durationMs !== undefined)
        await setProviderCooldown(keyLane, durationMs, coordinator).catch((cooldownError) =>
          console.error(
            `[llm] failed to publish distributed ${keyLane} cooldown:`,
            (cooldownError as Error).message,
          ),
        );
      throw error;
    }
  } finally {
    stopHeartbeat();
    if (localHeld) release(keyLane);
    if (leaseToken && coordinator)
      await coordinator
        .releaseProviderLease(provider, leaseToken)
        .catch((error) =>
          console.error(
            `[llm] failed to release distributed ${provider} lease:`,
            (error as Error).message,
          ),
        );
  }
}

export async function waitForProviderAvailability(
  providers: readonly string[],
  signal?: AbortSignal,
  coordinator: LlmProviderCoordinator | undefined = providerCoordinator,
  maxWaitMs = configuredAdmissionWaitMs,
): Promise<void> {
  const required = [...new Set(providers.filter(Boolean))];
  const deadline = Date.now() + Math.max(1, Math.floor(maxWaitMs));
  let announced = false;
  for (;;) {
    throwIfCancelled(signal);
    const waits = await Promise.all(
      required.map((provider) => getProviderCooldownMs(provider, coordinator)),
    );
    const waitMs = Math.max(0, ...waits);
    if (waitMs <= 0) {
      if (announced)
        console.log(`[llm] required provider cooldown cleared (${required.join(', ')})`);
      return;
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error(
        `429 required provider cooldown admission timed out (${required.join(', ')}); retry-after: ${Math.max(1, Math.ceil(waitMs / 1000))}`,
      );
    }
    if (!announced) {
      console.warn(
        `[llm] delaying review before paid calls: required provider cooldown active for up to ${Math.ceil(waitMs / 1000)}s (${required.join(', ')})`,
      );
      announced = true;
    }
    await sleep(Math.min(waitMs, remainingMs, 1_000), signal);
  }
}

/** Optional occupancy peek used to shrink per-review fanout under fleet load. */
export async function getProviderLoad(
  provider: string,
  coordinator: LlmProviderCoordinator | undefined = providerCoordinator,
): Promise<{ active: number; limit: number } | null> {
  if (!coordinator || typeof coordinator.getProviderLoad !== 'function') return null;
  try {
    return await coordinator.getProviderLoad(provider);
  } catch (error) {
    console.warn(
      `[llm] provider load peek failed for ${provider}:`,
      (error as Error).message?.slice(0, 120),
    );
    return null;
  }
}

/** Whole-review replays after Luna/Flash TPM 429s, independent of ORVEX_MAX_JOB_RETRIES. */
export const ADMISSION_JOB_REQUEUE_CAP = 8;

export function isProviderAdmissionError(message: string): boolean {
  return /concurrency saturated|admission timed out|provider lease|cooldown active|TPM .{0,120}exhausted|rate-limited on every|continuation rate-limited|requeueing instead of publishing|rate.?limit|tokens? per min|\bTPM\b.{0,80}(?:limit|used|exceed)|token plan|usage limit|overloaded|\b529\b/i.test(
    message,
  );
}

/** Luna, Flash, and MiniMax capacity misses — wait or requeue, never drop the pass. */
export function isProviderCapacityError(message: string): boolean {
  return isProviderAdmissionError(message) || isRetryableRateLimit(message);
}

export function shouldRequeueAdmissionFailure(message: string, attempts = 0): boolean {
  return (
    isProviderCapacityError(message) &&
    Math.max(0, Math.floor(attempts)) < ADMISSION_JOB_REQUEUE_CAP
  );
}
