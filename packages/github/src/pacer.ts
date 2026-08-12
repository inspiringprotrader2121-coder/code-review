/**
 * Per-installation request pacing. Production wires a Redis token bucket; tests
 * and local memory-queue mode use the in-process implementation.
 */
export interface GitHubInstallationPacer {
  /** Block until one request token is available for this installation. */
  acquire(installationId: number, signal?: AbortSignal): Promise<void>;
  /** Freeze the bucket after a Retry-After / secondary rate-limit response. */
  noteRetryAfter?(installationId: number, retryAfterMs: number): Promise<void>;
  close?(): Promise<void>;
}

export interface MemoryGitHubPacerOptions {
  /** Steady refill rate (tokens per second). */
  tokensPerSecond?: number;
  /** Burst capacity. */
  burst?: number;
  now?: () => number;
  maxWaitMs?: number;
}

interface MemoryBucket {
  tokens: number;
  updatedAt: number;
  frozenUntil: number;
}

/**
 * Process-local token bucket used when Redis pacing is unavailable.
 */
export class MemoryGitHubInstallationPacer implements GitHubInstallationPacer {
  private readonly buckets = new Map<number, MemoryBucket>();
  private readonly tokensPerSecond: number;
  private readonly burst: number;
  private readonly now: () => number;
  private readonly maxWaitMs: number;

  constructor(options: MemoryGitHubPacerOptions = {}) {
    this.tokensPerSecond = Math.max(0.1, options.tokensPerSecond ?? 8);
    this.burst = Math.max(1, Math.floor(options.burst ?? 20));
    this.now = options.now ?? Date.now;
    this.maxWaitMs = Math.max(1_000, Math.floor(options.maxWaitMs ?? 120_000));
  }

  async acquire(installationId: number, signal?: AbortSignal): Promise<void> {
    const deadline = this.now() + this.maxWaitMs;
    for (;;) {
      if (signal?.aborted) throw new Error('github request cancelled while waiting for pace token');
      const waitMs = this.tryTake(installationId);
      if (waitMs <= 0) return;
      const remaining = deadline - this.now();
      if (remaining <= 0) {
        throw new Error(
          `403 github installation ${installationId} paced; retry-after: ${Math.max(1, Math.ceil(waitMs / 1000))}`,
        );
      }
      await sleep(Math.min(waitMs, remaining, 250), signal);
    }
  }

  async noteRetryAfter(installationId: number, retryAfterMs: number): Promise<void> {
    const bucket = this.bucket(installationId);
    const now = this.now();
    const until = now + Math.min(300_000, Math.max(250, Math.floor(retryAfterMs)));
    bucket.frozenUntil = Math.max(bucket.frozenUntil, until);
    bucket.tokens = 0;
    // Do not credit the freeze window as refill time when it ends.
    bucket.updatedAt = now;
  }

  private tryTake(installationId: number): number {
    const bucket = this.bucket(installationId);
    const now = this.now();
    if (bucket.frozenUntil > now) return bucket.frozenUntil - now;
    const elapsed = Math.max(0, now - bucket.updatedAt);
    bucket.tokens = Math.min(this.burst, bucket.tokens + (elapsed / 1000) * this.tokensPerSecond);
    bucket.updatedAt = now;
    if (bucket.tokens < 1) {
      return Math.ceil(((1 - bucket.tokens) / this.tokensPerSecond) * 1000);
    }
    bucket.tokens -= 1;
    return 0;
  }

  private bucket(installationId: number): MemoryBucket {
    let current = this.buckets.get(installationId);
    if (!current) {
      current = { tokens: this.burst, updatedAt: this.now(), frozenUntil: 0 };
      this.buckets.set(installationId, current);
    }
    return current;
  }
}

let configuredPacer: GitHubInstallationPacer | undefined;

export function configureGitHubRequestPacer(pacer?: GitHubInstallationPacer): void {
  configuredPacer = pacer;
}

export function currentGitHubRequestPacer(): GitHubInstallationPacer | undefined {
  return configuredPacer;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('github request cancelled while waiting for pace token'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}
