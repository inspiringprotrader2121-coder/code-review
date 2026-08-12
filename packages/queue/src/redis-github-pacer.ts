import { Redis } from 'ioredis';

/**
 * Structural pacer interface mirrored from @orvex-review/github so the queue
 * package does not take a reverse dependency on github.
 */
export interface GitHubInstallationPacer {
  acquire(installationId: number, signal?: AbortSignal): Promise<void>;
  noteRetryAfter?(installationId: number, retryAfterMs: number): Promise<void>;
  close?(): Promise<void>;
}

export interface RedisGitHubPacerOptions {
  namespace: string;
  /** Steady refill rate (tokens per second). Default 8. */
  tokensPerSecond?: number;
  /** Burst capacity. Default 20. */
  burst?: number;
  maxWaitMs?: number;
  now?: () => number;
}

const TAKE_TOKEN = `
local capacity = tonumber(ARGV[1])
local ratePerMs = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
local data = redis.call('HMGET', KEYS[1], 'tokens', 'updated', 'frozen')
local tokens = tonumber(data[1])
local updated = tonumber(data[2])
local frozen = tonumber(data[3]) or 0
if tokens == nil then tokens = capacity end
if updated == nil then updated = now end
if frozen > now then
  return {0, tostring(math.max(1, math.floor(frozen - now))), tostring(tokens)}
end
local elapsed = math.max(0, now - updated)
tokens = math.min(capacity, tokens + elapsed * ratePerMs)
if tokens < cost then
  local need = cost - tokens
  local waitMs = math.max(1, math.ceil(need / ratePerMs))
  redis.call('HMSET', KEYS[1], 'tokens', tokens, 'updated', now, 'frozen', frozen)
  redis.call('PEXPIRE', KEYS[1], 300000)
  return {0, tostring(waitMs), tostring(tokens)}
end
tokens = tokens - cost
redis.call('HMSET', KEYS[1], 'tokens', tokens, 'updated', now, 'frozen', 0)
redis.call('PEXPIRE', KEYS[1], 300000)
return {1, '0', tostring(tokens)}
`;

const FREEZE = `
local untilMs = tonumber(ARGV[1])
local now = tonumber(ARGV[2])
local current = tonumber(redis.call('HGET', KEYS[1], 'frozen') or '0')
if untilMs > current then
  -- Reset updated so post-freeze refill does not credit the frozen window as
  -- a full burst (which re-trips GitHub secondary limits under concurrency).
  redis.call('HMSET', KEYS[1], 'frozen', untilMs, 'tokens', 0, 'updated', now)
end
redis.call('PEXPIRE', KEYS[1], 300000)
return 1
`;

/**
 * Per-installation Redis token bucket for GitHub App API pacing.
 */
export class RedisGitHubInstallationPacer implements GitHubInstallationPacer {
  private readonly redis: Redis;
  private readonly prefix: string;
  private readonly tokensPerSecond: number;
  private readonly burst: number;
  private readonly maxWaitMs: number;
  private readonly now: () => number;
  private readonly ownsClient: boolean;

  constructor(redisOrUrl: Redis | string, options: RedisGitHubPacerOptions) {
    this.ownsClient = typeof redisOrUrl === 'string';
    this.redis = typeof redisOrUrl === 'string' ? new Redis(redisOrUrl) : redisOrUrl;
    this.prefix = `${options.namespace}:github-pace:`;
    this.tokensPerSecond = Math.max(0.1, options.tokensPerSecond ?? 8);
    this.burst = Math.max(1, Math.floor(options.burst ?? 20));
    this.maxWaitMs = Math.max(1_000, Math.floor(options.maxWaitMs ?? 120_000));
    this.now = options.now ?? Date.now;
  }

  async acquire(installationId: number, signal?: AbortSignal): Promise<void> {
    const key = `${this.prefix}${Math.floor(installationId)}`;
    const ratePerMs = this.tokensPerSecond / 1000;
    const deadline = this.now() + this.maxWaitMs;
    for (;;) {
      if (signal?.aborted) throw new Error('github request cancelled while waiting for pace token');
      const result = (await this.redis.eval(
        TAKE_TOKEN,
        1,
        key,
        this.burst,
        ratePerMs,
        this.now(),
        1,
      )) as [number, string, string];
      if (Number(result[0]) === 1) return;
      const waitMs = Math.max(1, Number(result[1]) || 1);
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
    const now = this.now();
    const until = now + Math.min(300_000, Math.max(250, Math.floor(retryAfterMs)));
    await this.redis.eval(
      FREEZE,
      1,
      `${this.prefix}${Math.floor(installationId)}`,
      until,
      now,
    );
  }

  async close(): Promise<void> {
    if (this.ownsClient) await this.redis.quit();
  }
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
