import { currentEnvironment, loadReviewRuntimeConfig } from '@orvex-review/config';
import { ReviewCancelledError } from '../llm-client.js';
import { resolveCodexApiKeyConcurrency } from '../runtime-limits.js';
import type { CodexAuthMode } from './contracts.js';
import { detectCodexAuthMode, resolveCodexBinary } from './runtime.js';

export class CountingSemaphore {
  private active = 0;
  private readonly waiters: Array<{
    resolve: () => void;
    reject: (error: Error) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
  }> = [];
  constructor(private limit: number) {
    this.limit = Math.max(1, Math.floor(limit));
  }
  get concurrency(): number {
    return this.limit;
  }
  get inFlight(): number {
    return this.active;
  }
  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      if (signal?.aborted) throw new ReviewCancelledError('codex-cli review cancelled');
      return await fn();
    } finally {
      this.release();
    }
  }
  private acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted)
      return Promise.reject(new ReviewCancelledError('codex-cli review cancelled'));
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const waiter: {
        resolve: () => void;
        reject: (error: Error) => void;
        signal?: AbortSignal;
        onAbort?: () => void;
      } = { resolve, reject, signal };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          signal.removeEventListener('abort', waiter.onAbort!);
          reject(new ReviewCancelledError('codex-cli review cancelled'));
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
      if (signal?.aborted) waiter.onAbort?.();
    });
  }
  private release(): void {
    this.active = Math.max(0, this.active - 1);
    for (;;) {
      const next = this.waiters.shift();
      if (!next) return;
      if (next.signal && next.onAbort) next.signal.removeEventListener('abort', next.onAbort);
      if (next.signal?.aborted) {
        next.reject(new ReviewCancelledError('codex-cli review cancelled'));
        continue;
      }
      this.active++;
      next.resolve();
      return;
    }
  }
}

export function resolveCodexHomeConcurrency(mode: CodexAuthMode, env?: NodeJS.ProcessEnv): number {
  return mode === 'apikey' ? resolveCodexApiKeyConcurrency(env) : 1;
}

const configured = loadReviewRuntimeConfig();
const homes: (string | undefined)[] =
  configured.codexHomes.length > 0 ? [...configured.codexHomes] : [configured.codexHome];
const busy = homes.map(() => 0);
const deadUntil = homes.map(() => 0);
const gates = homes.map(() => new CountingSemaphore(1));
const resumeChains = new Map<string, Promise<unknown>>();
const BENCH_MS = 15 * 60_000;
let testOverride: { mode: CodexAuthMode; env: NodeJS.ProcessEnv } | undefined;

export function assertCodexRuntimeReady(
  testHomes: readonly (string | undefined)[] = homes,
): string {
  const binary = resolveCodexBinary();
  if (!testHomes.some((home) => detectCodexAuthMode(home) === 'apikey')) {
    throw new Error('codex-cli Luna requires at least one API-key-authenticated Codex home');
  }
  return binary;
}

function gateFor(index: number): CountingSemaphore {
  const mode = testOverride?.mode ?? detectCodexAuthMode(homes[index]);
  const limit = resolveCodexHomeConcurrency(mode, testOverride?.env ?? currentEnvironment());
  if (gates[index]!.concurrency !== limit && gates[index]!.inFlight === 0)
    gates[index] = new CountingSemaphore(limit);
  return gates[index]!;
}

export function pickCodexHome(preferred?: number): number {
  const now = Date.now();
  if (
    preferred !== undefined &&
    preferred < homes.length &&
    deadUntil[preferred] <= now &&
    detectCodexAuthMode(homes[preferred]) === 'apikey'
  )
    return preferred;
  let best = 0;
  let score = Infinity;
  for (let index = 0; index < homes.length; index++) {
    const unavailable = deadUntil[index]! > now || detectCodexAuthMode(homes[index]) !== 'apikey';
    const nextScore = (unavailable ? 1_000 : 0) + busy[index]!;
    if (nextScore < score) {
      best = index;
      score = nextScore;
    }
  }
  return best;
}

export function codexHome(index: number): string | undefined {
  return homes[index];
}
export function codexHomeLabel(index: number): string {
  return homes[index] ?? '~/.codex';
}
export function benchCodexHome(index: number): void {
  deadUntil[index] = Date.now() + BENCH_MS;
}
export function codexHomeCount(): number {
  return homes.length;
}

export async function withCodexHomeLock<T>(
  index: number,
  run: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  busy[index]++;
  try {
    return await gateFor(index).run(run, signal);
  } finally {
    busy[index]--;
  }
}

export async function withCodexResumeLock<T>(
  index: number,
  threadId: string | undefined,
  model: string,
  run: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!threadId) return withCodexHomeLock(index, run, signal);
  const key = `${index}:${threadId}:${model}`;
  const prior = resumeChains.get(key) ?? Promise.resolve();
  const current = prior.then(() => withCodexHomeLock(index, run, signal));
  const link = current.catch(() => {});
  resumeChains.set(key, link);
  try {
    return await current;
  } finally {
    if (resumeChains.get(key) === link) resumeChains.delete(key);
  }
}

export async function withCodexHomeLockForTest<T>(
  options: { mode: CodexAuthMode; env?: NodeJS.ProcessEnv },
  test: (withLock: <R>(run: () => Promise<R>, signal?: AbortSignal) => Promise<R>) => Promise<T>,
): Promise<T> {
  const previous = testOverride;
  const previousGate = gates[0]!;
  const previousBusy = busy[0]!;
  testOverride = { mode: options.mode, env: options.env ?? currentEnvironment() };
  gates[0] = new CountingSemaphore(1);
  busy[0] = 0;
  try {
    return await test((run, signal) => withCodexHomeLock(0, run, signal));
  } finally {
    testOverride = previous;
    gates[0] = previousGate;
    busy[0] = previousBusy;
  }
}

export function decodeCodexThreadRef(ref?: string): { homeIdx?: number; threadId?: string } {
  if (!ref) return {};
  const match = /^h(\d+):(.+)$/.exec(ref);
  if (match) {
    const index = Number(match[1]);
    return index < homes.length ? { homeIdx: index, threadId: match[2] } : {};
  }
  return { homeIdx: 0, threadId: ref };
}
export function encodeCodexThreadRef(index: number, threadId: string): string {
  return homes.length > 1 ? `h${index}:${threadId}` : threadId;
}
