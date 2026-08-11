import { resolveProviderConcurrency } from '../runtime-limits.js';
import type { LlmClientOptions, LlmProviderCoordinator } from './contracts.js';
import { ReviewCancelledError, throwIfCancelled } from './cancellation.js';
import { providerCooldownForFailure, sleep } from './retry-policy.js';
import { providerName } from './support.js';

let providerCoordinator: LlmProviderCoordinator | undefined;
let configuredProviderConcurrency: ((provider: string) => number) | undefined;
const localProviderCooldownUntil = new Map<string, number>();

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
): void {
  providerCoordinator = coordinator;
  configuredProviderConcurrency = localProviderConcurrency;
}
export function currentProviderCoordinator(): LlmProviderCoordinator | undefined {
  return providerCoordinator;
}
export function providerConcurrency(provider: string, env?: NodeJS.ProcessEnv): number {
  if (env === undefined && configuredProviderConcurrency)
    return configuredProviderConcurrency(provider);
  return resolveProviderConcurrency(provider, env);
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
async function acquire(provider: string, signal?: AbortSignal): Promise<void> {
  throwIfCancelled(signal);
  const gate = gateFor(provider);
  if (gate.active < providerConcurrency(provider)) {
    gate.active++;
    return;
  }
  await new Promise<void>((resolve, reject) => {
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
      reject(new Error(`429 provider ${provider} local concurrency saturated; retry-after: 1`));
    }, 30_000);
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

export async function withProviderCallSlot<T>(
  provider: string,
  fn: () => Promise<T>,
  signal?: AbortSignal,
  coordinator: LlmProviderCoordinator | undefined = providerCoordinator,
): Promise<T> {
  await acquire(provider, signal);
  let leaseToken: string | undefined;
  try {
    throwIfCancelled(signal);
    const cooldownMs = await getProviderCooldownMs(provider, coordinator);
    if (cooldownMs > 0)
      throw new Error(
        `429 provider ${provider} cooldown active; retry-after: ${Math.ceil(cooldownMs / 1000)}`,
      );
    if (coordinator) {
      leaseToken = await coordinator.acquireProviderLease(
        provider,
        providerConcurrency(provider),
        signal,
      );
      const postLeaseCooldownMs = await getProviderCooldownMs(provider, coordinator);
      if (postLeaseCooldownMs > 0)
        throw new Error(
          `429 provider ${provider} cooldown active; retry-after: ${Math.ceil(postLeaseCooldownMs / 1000)}`,
        );
    }
    try {
      return await fn();
    } catch (error) {
      const durationMs = signal?.aborted
        ? undefined
        : providerCooldownForFailure((error as Error)?.message ?? String(error));
      if (durationMs !== undefined)
        await setProviderCooldown(provider, durationMs, coordinator).catch((cooldownError) =>
          console.error(
            `[llm] failed to publish distributed ${provider} cooldown:`,
            (cooldownError as Error).message,
          ),
        );
      throw error;
    }
  } finally {
    if (leaseToken && coordinator)
      await coordinator
        .releaseProviderLease(provider, leaseToken)
        .catch((error) =>
          console.error(
            `[llm] failed to release distributed ${provider} lease:`,
            (error as Error).message,
          ),
        );
    release(provider);
  }
}

export async function waitForProviderAvailability(
  providers: readonly string[],
  signal?: AbortSignal,
  coordinator: LlmProviderCoordinator | undefined = providerCoordinator,
  maxWaitMs = 30_000,
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
        `429 required provider cooldown admission timed out (${required.join(', ')}); retry-after: 1`,
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
