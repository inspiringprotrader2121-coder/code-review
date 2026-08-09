import Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'node:crypto';

export type LlmAttemptOutcome =
  | 'succeeded'
  | 'failed'
  | 'timed_out'
  | 'cancelled'
  | 'rate_limited';

export type LlmAttemptEvent =
  | {
      phase: 'started';
      attemptId: string;
      parentAttemptId?: string;
      retryIndex: number;
      keyIndex: number;
      provider: string;
      model: string;
      transport: 'responses' | 'chat' | 'anthropic' | 'codex-cli';
      startedAt: string;
    }
  | {
      phase: 'finished';
      attemptId: string;
      outcome: LlmAttemptOutcome;
      durationMs: number;
      completedAt: string;
      error?: string;
    };

/** Structural interface implemented by the Redis queue in production. */
export interface LlmProviderCoordinator {
  acquireProviderLease(provider: string, limit: number, signal?: AbortSignal): Promise<string>;
  releaseProviderLease(provider: string, token: string): Promise<void>;
  getProviderCooldownMs(provider: string): Promise<number>;
  setProviderCooldown(provider: string, durationMs: number): Promise<void>;
}

let providerCoordinator: LlmProviderCoordinator | undefined;

export function configureLlmProviderCoordinator(coordinator?: LlmProviderCoordinator): void {
  providerCoordinator = coordinator;
}

export interface LlmClientOptions {
  apiKey: string;
  model: string;
  /** Provider base URL. Omit only for Anthropic's default endpoint. */
  baseUrl?: string;
  maxTokens?: number;
  /** ask the provider for a JSON object response where supported */
  json?: boolean;
  /** force-disable reasoning for this call (default: reasoning ON) */
  thinking?: boolean;
  /**
   * Which OpenAI-family API shape to use. 'responses' = the /v1/responses
   * endpoint (required by gpt-5.x / codex reasoning models — different request +
   * streaming shape). Default (undefined) = /chat/completions (MiniMax, etc.).
   */
  api?: 'chat' | 'responses' | 'anthropic';
  /** reasoning effort for /v1/responses models (e.g. 'low'|'medium'|'high'|'xhigh'). */
  reasoningEffort?: string;
  /** Sampling temperature. Only set for explicitly repeated review samples. */
  temperature?: number;
  /** Cancel this exact provider call (for example when its PR closes). */
  signal?: AbortSignal;
  /**
   * Called once per completed call with token usage, for cost tracking. Anthropic
   * reports exact usage; the OpenAI-compatible/streaming path estimates from
   * character counts (~4 chars/token) since it doesn't request a usage object.
   */
  onUsage?: (usage: {
    inputTokens: number;
    outputTokens: number;
    tokenSource?: 'provider' | 'estimate';
    /** Provider/model that received this call, for cost attribution. */
    provider?: string;
    model?: string;
    attemptId?: string;
  }) => void;
  /** Durable lifecycle hook for every actual provider request. */
  onAttempt?: (event: LlmAttemptEvent) => void;
}

/** Typed cancellation is deliberately non-transient: a closed PR must never
 * enter provider retry/failover loops or publish a provider cooldown. */
export class ReviewCancelledError extends Error {
  override name = 'ReviewCancelledError';

  constructor(message = 'review cancelled') {
    super(message);
  }
}

export function isReviewCancelledError(error: unknown): boolean {
  return error instanceof ReviewCancelledError || (error as { name?: string })?.name === 'ReviewCancelledError';
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ReviewCancelledError();
}

function linkAbortSignal(signal: AbortSignal | undefined, controller: AbortController): () => void {
  if (!signal) return () => {};
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  return () => signal.removeEventListener('abort', abort);
}

/** Rough chars→tokens estimate (~4 chars/token) for providers that don't return
 *  a usage object on the streaming path. Approximate but good enough for cost
 *  visibility / spend alerting. */
export function estimateTokens(chars: number): number {
  return Math.max(0, Math.round(chars / 4));
}

/** Hard ceiling on any single LLM call so a hung provider can't wedge a job. */
const LLM_TIMEOUT_MS = (() => {
  // A typo'd value yielded NaN, and setTimeout(NaN) fires at ~1ms — every call
  // would abort instantly as "stalled". Same guard as the other numeric envs.
  const n = Number(process.env.ORVEX_LLM_TIMEOUT_MS ?? 240_000);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.max(Math.floor(n), 1_000), 900_000) : 240_000;
})();

/** Total time allowed for one provider attempt, including active streaming. */
function maxTotalMs(): number {
  const configured = Number(process.env.ORVEX_LLM_MAX_TOTAL_MS ?? 300_000);
  const minimum = process.env.ORVEX_TEST_SHORT_TIMEOUTS === '1' ? 10 : 30_000;
  return Number.isFinite(configured) ? Math.min(Math.max(configured, minimum), 300_000) : 300_000;
}

/** Reasoning models think before answering — slower, materially more accurate. */
function thinkingEnabled(opts: LlmClientOptions): boolean {
  return opts.thinking ?? true;
}

/**
 * One chat call, either provider:
 * - `baseUrl` set → OpenAI-compatible `/chat/completions` (MiniMax, etc.)
 * - otherwise → Anthropic SDK
 */

/**
 * True for a provider rate-limit / quota-exhaustion error specifically —
 * deliberately narrower than `isTransientLlmError` (packages/review/src/llm.ts),
 * which also matches generic network blips (timeouts, ECONNRESET, "fetch
 * failed"). That distinction is intentional: a transient network hiccup on the
 * PRIMARY provider is retried on the SAME provider. This narrower classifier is
 * used only to rotate comma-separated sibling keys for the same configured
 * model/provider; contracted review stages never substitute another model.
 * Exported so it's independently unit-tested rather than a silent duplicate.
 */
export function isRateLimitOrQuotaError(message: string): boolean {
  // 529/overloaded belongs here too so sibling keys can be rotated promptly.
  return /\b429\b|\b529\b|overloaded|\b402\b[^\n]*(?:credit|quota|payment)|rate.?limit|usage limit|quota|token plan|insufficient|more credits?/i.test(
    message,
  );
}

/**
 * A 128k default made OpenAI-compatible gateways reserve far more output credit
 * than a review can realistically use, causing otherwise-funded requests to be
 * rejected before generation. Historical xhigh reviews peak around 40k output
 * tokens including reasoning, so 64k preserves headroom without the false
 * "insufficient credits" failures.
 *
 * A HARD CAP backstops this: gateways (OpenRouter etc.) RESERVE the full
 * max_tokens as credit up front, so an oversized value — e.g. a mis-set
 * `ORVEX_MAX_OUTPUT_TOKENS=200000` in the live env — makes every reasoning call
 * fail with `402 insufficient credits` ("requested 128000, can only afford
 * 71299"), which then silently degrades to no-reasoning and thin reviews. That
 * exact misconfig took production down for a week, so the ceiling is enforced
 * in code, not just documented. Raise it deliberately via
 * ORVEX_MAX_OUTPUT_TOKENS_CAP when a provider genuinely needs more.
 */
const DEFAULT_MAX_OUTPUT_TOKENS = 64_000;
const ABSOLUTE_MAX_OUTPUT_TOKENS = 1_000_000;

function providerName(baseUrl: string | undefined, api: LlmClientOptions['api']): string {
  if (api === 'anthropic' || (!baseUrl && api !== 'responses' && api !== 'chat')) return 'anthropic';
  if (!baseUrl) return 'openai';
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return 'openai-compatible';
  }
}

/**
 * Bound provider calls across every review in this worker process. Per-review
 * fan-out alone multiplied by the number of worker jobs and caused provider
 * throttling/tail latency to grow as 4 reviews × 3 calls competed at once.
 */
interface LlmSlotWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}
interface ProviderGate {
  active: number;
  waiters: LlmSlotWaiter[];
}
const providerGates = new Map<string, ProviderGate>();
const localProviderCooldownUntil = new Map<string, number>();

function providerConcurrency(provider: string): number {
  const normalized = provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  // Two max-reasoning Flash passes on one key compete for the same generation
  // throughput and both can cross the wall-clock cap. Serialize DeepSeek while
  // keeping independent providers concurrent.
  const defaults: Record<string, number> = { LUNA: 1, DEEPSEEK: 1, MINIMAX: 2 };
  const fallback = defaults[normalized] ?? 4;
  const raw = process.env[`ORVEX_PROVIDER_CONCURRENCY_${normalized}`];
  const parsed = raw === undefined || raw.trim() === '' ? fallback : Number(raw);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.min(32, Math.floor(parsed)) : fallback;
}

export function providerBucketForTarget(
  opts: Pick<LlmClientOptions, 'model' | 'baseUrl' | 'api'>,
): string {
  const identity = `${opts.model} ${opts.baseUrl ?? ''}`.toLowerCase();
  if (identity.includes('luna') || identity.includes('api.openai.com')) return 'luna';
  if (identity.includes('deepseek')) return 'deepseek';
  if (identity.includes('minimax')) return 'minimax';
  return providerName(opts.baseUrl, opts.api).toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function gateFor(provider: string): ProviderGate {
  let gate = providerGates.get(provider);
  if (!gate) {
    gate = { active: 0, waiters: [] };
    providerGates.set(provider, gate);
  }
  return gate;
}

function detachLlmWaiter(waiter: LlmSlotWaiter): void {
  if (waiter.signal && waiter.onAbort) {
    waiter.signal.removeEventListener('abort', waiter.onAbort);
  }
}

async function acquireGlobalLlmSlot(provider: string, signal?: AbortSignal): Promise<void> {
  throwIfCancelled(signal);
  const gate = gateFor(provider);
  if (gate.active >= providerConcurrency(provider)) {
    await new Promise<void>((resolve, reject) => {
      const waiter: LlmSlotWaiter = { resolve, reject, signal };
      if (signal) {
        waiter.onAbort = () => {
          const index = gate.waiters.indexOf(waiter);
          if (index >= 0) gate.waiters.splice(index, 1);
          detachLlmWaiter(waiter);
          reject(new ReviewCancelledError());
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      gate.waiters.push(waiter);
      if (signal?.aborted) waiter.onAbort?.();
    });
  } else {
    gate.active++;
  }
}

function releaseGlobalLlmSlot(provider: string): void {
  const gate = gateFor(provider);
  for (;;) {
    const next = gate.waiters.shift();
    if (!next) {
      gate.active = Math.max(0, gate.active - 1);
      return;
    }
    detachLlmWaiter(next);
    if (next.signal?.aborted) {
      next.reject(new ReviewCancelledError());
      continue;
    }
    // Transfer this slot to the waiter; active count stays unchanged.
    next.resolve();
    return;
  }
}

export async function withProviderCallSlot<T>(
  provider: string,
  fn: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  await acquireGlobalLlmSlot(provider, signal);
  let leaseToken: string | undefined;
  try {
    throwIfCancelled(signal);
    const cooldownMs = await getProviderCooldownMs(provider);
    if (cooldownMs > 0) {
      throw new Error(`429 provider ${provider} cooldown active; retry-after: ${Math.ceil(cooldownMs / 1000)}`);
    }
    if (providerCoordinator) {
      leaseToken = await providerCoordinator.acquireProviderLease(
        provider,
        providerConcurrency(provider),
        signal,
      );
      // A prior holder may have published a cooldown immediately before it
      // released the lease. Waiters passed the first check before blocking, so
      // re-check after acquisition and refuse to start paid work in that window.
      const postLeaseCooldownMs = await getProviderCooldownMs(provider);
      if (postLeaseCooldownMs > 0) {
        throw new Error(
          `429 provider ${provider} cooldown active; retry-after: ${Math.ceil(postLeaseCooldownMs / 1000)}`,
        );
      }
    }
    try {
      return await fn();
    } catch (error) {
      const message = (error as Error)?.message ?? String(error);
      // Publish the provider-specific cooldown while the distributed lease is
      // still held. Otherwise the next worker can acquire the released lease in
      // the small gap before the outer retry loop records the cooldown, causing
      // an avoidable cross-process retry stampede.
      const durationMs = signal?.aborted ? undefined : providerCooldownForFailure(message);
      if (durationMs !== undefined) {
        await setProviderCooldown(provider, durationMs).catch((cooldownError) => {
          console.error(
            `[llm] failed to publish distributed ${provider} cooldown:`,
            (cooldownError as Error).message,
          );
        });
      }
      throw error;
    }
  } finally {
    if (leaseToken && providerCoordinator) {
      await providerCoordinator.releaseProviderLease(provider, leaseToken).catch((err) => {
        console.error(`[llm] failed to release distributed ${provider} lease:`, (err as Error).message);
      });
    }
    releaseGlobalLlmSlot(provider);
  }
}

export async function setProviderCooldown(provider: string, durationMs: number): Promise<void> {
  const bounded = Math.min(300_000, Math.max(250, Math.floor(durationMs)));
  localProviderCooldownUntil.set(
    provider,
    Math.max(localProviderCooldownUntil.get(provider) ?? 0, Date.now() + bounded),
  );
  if (providerCoordinator) await providerCoordinator.setProviderCooldown(provider, bounded);
}

export async function getProviderCooldownMs(provider: string): Promise<number> {
  const local = Math.max(0, (localProviderCooldownUntil.get(provider) ?? 0) - Date.now());
  const distributed = providerCoordinator
    ? await providerCoordinator.getProviderCooldownMs(provider)
    : 0;
  return Math.max(local, distributed);
}

export function resolveMaxOutputTokens(explicit?: number): number {
  const configured = explicit ?? Number(process.env.ORVEX_MAX_OUTPUT_TOKENS ?? DEFAULT_MAX_OUTPUT_TOKENS);
  const valid =
    Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : DEFAULT_MAX_OUTPUT_TOKENS;
  const capRaw = Number(process.env.ORVEX_MAX_OUTPUT_TOKENS_CAP ?? DEFAULT_MAX_OUTPUT_TOKENS);
  const cap =
    Number.isFinite(capRaw) && capRaw > 0
      ? Math.min(Math.floor(capRaw), ABSOLUTE_MAX_OUTPUT_TOKENS)
      : DEFAULT_MAX_OUTPUT_TOKENS;
  if (valid > cap) {
    console.warn(
      `[llm] max_output_tokens ${valid} exceeds safe cap ${cap} — clamping. ` +
        `Oversized reservations trigger 402 "insufficient credits" and silently ` +
        `disable reasoning. Raise ORVEX_MAX_OUTPUT_TOKENS_CAP to lift the ceiling deliberately.`,
    );
  }
  return Math.min(valid, cap);
}

/**
 * Multi-key load balancing: `apiKey` may hold MULTIPLE comma-separated keys
 * (e.g. ORVEX_STANDARD_API_KEY=key1,key2,key3). Calls round-robin across the
 * keys, and a key that hits a rate-limit/quota error rotates to the next key for
 * the same configured provider/model. There is no substitute-provider path.
 */
let keyCursor = 0;
function splitKeys(apiKey: string): string[] {
  return apiKey
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
}

/** Parse a provider's "try again in N" hint into milliseconds. OpenAI embeds it
 * in the 429 body ("Please try again in 49.174s" / "in 120ms"); Anthropic and
 * others use "retry-after". Returns undefined when no explicit delay is given. */
export function parseRetryAfterMs(message: string): number | undefined {
  const ms = /try again in\s*([\d.]+)\s*ms\b/i.exec(message);
  if (ms) return Math.ceil(parseFloat(ms[1]));
  // "retry-after: 30" / "retry after 12 seconds" — the HTTP header value is bare
  // seconds, so the unit suffix is optional here.
  const ra = /retry[-\s]?after[:\s]+([\d.]+)\s*(?:s(?:ec(?:onds?)?)?)?\b/i.exec(message);
  if (ra) return Math.ceil(parseFloat(ra[1]) * 1000);
  const sec = /try again in\s*([\d.]+)\s*s(?:ec(?:onds?)?)?\b/i.exec(message);
  if (sec) return Math.ceil(parseFloat(sec[1]) * 1000);
  return undefined;
}

/** A rate limit that RECOVERS by waiting — a per-minute TPM/RPM 429, a 529
 * "overloaded", a "try again in Ns". Deliberately DISTINCT from a hard
 * credit/quota exhaustion (402 "insufficient credits"), which waiting will not
 * fix: that must fail fast so the job requeues instead of looping pointlessly.
 *
 * Also DISTINCT from oversized-request / context-window errors: sleeping does
 * not shrink the payload. Those must fail immediately so the caller can fall
 * back to a smaller API path instead of burning minutes of backoff. */
export function isOversizedModelRequest(message: string): boolean {
  return (
    /request too large/i.test(message)
    || /context[_ ]length[_ ]exceeded/i.test(message)
    || /maximum context length/i.test(message)
    || /string_above_max_length/i.test(message)
    || /prompt is too long/i.test(message)
    || /input\s+tokens?\s+exceed/i.test(message)
  );
}

export function isRetryableRateLimit(message: string): boolean {
  // Hard billing exhaustion is NOT recoverable by waiting, however it is dressed:
  //  - a 402 status carrying credit wording, and
  //  - OpenAI's `insufficient_quota`, which ships as HTTP *429* and would
  //    otherwise be retried forever on every review.
  // Anchor the 402 to the STATUS position so an unrelated "402" inside a message
  // body ("used 402 of 500 credits") can't misclassify a genuine 429.
  const status = /\brequest failed\s*\(\s*(\d{3})\b/i.exec(message)?.[1];
  if (status === '402' && /credit|insufficient|afford|top-?up/i.test(message)) return false;
  if (/insufficient_quota|exceeded your current quota|billing_hard_limit/i.test(message)) return false;
  // Payload/context too large: never sleep-retry as if it were TPM.
  if (isOversizedModelRequest(message)) return false;
  return /\b429\b|\b529\b|rate.?limit|tokens? per min|requests? per min|\bTPM\b|\bRPM\b|try again in|overloaded|please try again/i.test(
    message,
  );
}

/** Provider-scoped circuit duration for failures that indicate the provider is
 * unavailable. Timeouts are not replayed, but they still cool that provider so
 * a large queue cannot immediately repeat the same failure in parallel. */
function providerCooldownForFailure(message: string): number | undefined {
  if (isOversizedModelRequest(message)) return undefined;
  if (/insufficient_quota|exceeded your current quota|billing_hard_limit/i.test(message)) {
    return 300_000;
  }
  const status = /\brequest failed\s*\(\s*(\d{3})\b/i.exec(message)?.[1];
  if (status === '402' && /credit|insufficient|afford|top-?up/i.test(message)) {
    return 300_000;
  }
  const advertised = parseRetryAfterMs(message);
  if (advertised !== undefined) return Math.min(300_000, Math.max(2_000, advertised));
  if (isRetryableRateLimit(message)) return 2_000;
  if (/\b(?:408|425|5\d\d)\b|fetch failed|econn|socket hang|wall-clock cap|timed?\s*out|stalled|produced no output/i.test(message)) {
    return 30_000;
  }
  return undefined;
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    throwIfCancelled(signal);
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ReviewCancelledError());
    };
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });

/** Wait before starting a multi-provider ensemble when any required provider is
 * cooling down. This prevents sibling providers from spending on a review that
 * cannot complete, without pausing jobs that use an independent provider set. */
export async function waitForProviderAvailability(
  providers: readonly string[],
  signal?: AbortSignal,
): Promise<void> {
  const required = [...new Set(providers.filter(Boolean))];
  let announced = false;
  for (;;) {
    throwIfCancelled(signal);
    const waits = await Promise.all(required.map((provider) => getProviderCooldownMs(provider)));
    const waitMs = Math.max(0, ...waits);
    if (waitMs <= 0) {
      if (announced) console.log(`[llm] required provider cooldown cleared (${required.join(', ')})`);
      return;
    }
    if (!announced) {
      console.warn(
        `[llm] delaying review before paid calls: required provider cooldown active ` +
          `for up to ${Math.ceil(waitMs / 1000)}s (${required.join(', ')})`,
      );
      announced = true;
    }
    await sleep(Math.min(waitMs, 1_000), signal);
  }
}

/**
 * Public entry point. Wraps same-provider key rotation below in a
 * WAIT-AND-RETRY loop: a recoverable rate limit HOLDS the call and retries
 * (honoring the provider's advertised retry-after) instead of failing the pass
 * and discarding the whole review — the "queue it, don't cancel it" behavior.
 * Provider-agnostic: every model (OpenAI/Luna, DeepSeek, MiniMax, Anthropic)
 * funnels through here, so all get it for free. Ordinary errors and hard quota
 * exhaustion propagate immediately (no wasted waiting).
 */
export async function llmChat(system: string, user: string, opts: LlmClientOptions): Promise<string> {
  const finite = (raw: string | undefined, fallback: number): number => {
    // Empty/whitespace means UNSET — `Number('')` is 0 and would pass a bare
    // isFinite check, turning `FOO=` into a real zero.
    if (raw === undefined || raw.trim() === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  };
  // One paid retry at most. A provider request can consume tokens before a
  // transport/rate-limit error is returned; ten replay rounds multiplied cost
  // without improving the probability of recovery inside the same quota window.
  const maxAttempts = Math.min(2, Math.max(1, Math.floor(finite(process.env.ORVEX_RATELIMIT_MAX_RETRIES, 2))));
  const maxWaitMs = Math.min(300_000, Math.max(1_000, finite(process.env.ORVEX_RATELIMIT_MAX_WAIT_MS, 60_000)));
  const baseMs = Math.min(60_000, Math.max(250, finite(process.env.ORVEX_RATELIMIT_BASE_MS, 2_000)));
  // TOTAL sleep budget across this call. Each attempt replays the whole key
  // rotation chain, so an unbounded per-attempt wait compounds into minutes of
  // a worker slot held asleep. Bound the total; the provider-specific cooldown
  // admission handles later reviews without replaying this ensemble.
  const totalWaitBudgetMs = Math.min(
    60_000,
    Math.max(5_000, finite(process.env.ORVEX_RATELIMIT_TOTAL_WAIT_MS, 60_000)),
  );
  const provider = providerBucketForTarget(opts);
  const lineage = { lastAttemptId: undefined as string | undefined };
  let sleptMs = 0;
  let lastErr: Error | undefined;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    throwIfCancelled(opts.signal);
    let enteredProviderCall = false;
    try {
      return await withProviderCallSlot(
        provider,
        () => {
          enteredProviderCall = true;
          return llmChatWithKeyRotation(system, user, opts, attempt, lineage);
        },
        opts.signal,
      );
    } catch (err) {
      lastErr = opts.signal?.aborted && !isReviewCancelledError(err)
        ? new ReviewCancelledError()
        : err as Error;
      if (!enteredProviderCall) {
        recordProviderAdmissionFailure(opts, attempt, lineage, lastErr);
      }
      if (isReviewCancelledError(lastErr) || opts.signal?.aborted) throw new ReviewCancelledError();
      if (attempt === maxAttempts - 1 || !isRetryableRateLimit(lastErr.message)) throw lastErr;
      // Honor the provider's advertised retry-after; otherwise exponential
      // backoff. Always add jitter so concurrent passes don't retry in lockstep,
      // and never exceed the per-wait cap.
      const advertised = parseRetryAfterMs(lastErr.message);
      // An advertised delay LONGER than we're willing to wait means waiting
      // cannot help (an hourly/daily window) — fail fast instead of burning the
      // remaining attempts on retries guaranteed to land inside the same window.
      if (advertised !== undefined && advertised > maxWaitMs) {
        console.warn(
          `[llm] rate limit window ${Math.round(advertised / 1000)}s exceeds max wait ` +
            `${Math.round(maxWaitMs / 1000)}s — failing fast instead of retrying into it`,
        );
        throw lastErr;
      }
      const backoff = Math.min(baseMs * 2 ** attempt, maxWaitMs);
      const jitter = Math.floor(Math.random() * 1_000);
      const waitMs = Math.min((advertised ?? backoff) + jitter, maxWaitMs);
      if (sleptMs + waitMs > totalWaitBudgetMs) {
        console.warn(
          `[llm] rate-limit wait budget exhausted (${Math.round(sleptMs / 1000)}s slept of ` +
            `${Math.round(totalWaitBudgetMs / 1000)}s) — failing so the job requeues instead of holding a worker slot`,
        );
        throw lastErr;
      }
      sleptMs += waitMs;
      await setProviderCooldown(provider, waitMs);
      console.warn(
        `[llm] rate-limited — holding ${Math.round(waitMs / 1000)}s then retrying ` +
          `(attempt ${attempt + 1}/${maxAttempts}): ${lastErr.message.slice(0, 140)}`,
      );
      await sleep(waitMs, opts.signal);
      // The first failed request publishes its cooldown before releasing the
      // distributed lease. Wait out any longer advertised/provider window too,
      // so this retry cannot fail at admission a few milliseconds early.
      await waitForProviderAvailability([provider], opts.signal);
    }
  }
  throw lastErr!;
}

function recordProviderAdmissionFailure(
  opts: LlmClientOptions,
  retryIndex: number,
  lineage: { lastAttemptId?: string },
  error: Error,
): void {
  if (!opts.onAttempt) return;
  const attemptId = randomUUID();
  const timestamp = new Date().toISOString();
  const transport = opts.api === 'responses'
    ? 'responses'
    : opts.api === 'anthropic' || (!opts.baseUrl && opts.api !== 'chat')
      ? 'anthropic'
      : 'chat';
  opts.onAttempt({
    phase: 'started',
    attemptId,
    parentAttemptId: lineage.lastAttemptId,
    retryIndex,
    keyIndex: 0,
    provider: providerName(opts.baseUrl, opts.api),
    model: opts.model,
    transport,
    startedAt: timestamp,
  });
  lineage.lastAttemptId = attemptId;
  opts.onAttempt({
    phase: 'finished',
    attemptId,
    outcome: attemptOutcome(error),
    error: error.message.slice(0, 2_000),
    durationMs: 0,
    completedAt: timestamp,
  });
}

function attemptOutcome(error: unknown): LlmAttemptOutcome {
  if (isReviewCancelledError(error)) return 'cancelled';
  const message = (error as Error)?.message ?? String(error);
  if (/wall-clock cap|timed?\s*out|stalled/i.test(message)) return 'timed_out';
  if (isRateLimitOrQuotaError(message)) return 'rate_limited';
  return 'failed';
}

async function trackedLlmAttempt(
  system: string,
  user: string,
  opts: LlmClientOptions,
  retryIndex: number,
  keyIndex: number,
  lineage: { lastAttemptId?: string },
): Promise<string> {
  const attemptId = randomUUID();
  const started = Date.now();
  const provider = providerName(opts.baseUrl, opts.api);
  const transport = opts.api === 'responses'
    ? 'responses'
    : opts.api === 'anthropic' || (!opts.baseUrl && opts.api !== 'chat')
      ? 'anthropic'
      : 'chat';
  opts.onAttempt?.({
    phase: 'started',
    attemptId,
    parentAttemptId: lineage.lastAttemptId,
    retryIndex,
    keyIndex,
    provider,
    model: opts.model,
    transport,
    startedAt: new Date(started).toISOString(),
  });
  lineage.lastAttemptId = attemptId;
  try {
    const result = await llmChatSingle(system, user, {
      ...opts,
      onUsage: opts.onUsage
        ? (usage) => opts.onUsage?.({ ...usage, attemptId })
        : undefined,
    });
    opts.onAttempt?.({
      phase: 'finished',
      attemptId,
      outcome: 'succeeded',
      durationMs: Date.now() - started,
      completedAt: new Date().toISOString(),
    });
    return result;
  } catch (error) {
    opts.onAttempt?.({
      phase: 'finished',
      attemptId,
      outcome: attemptOutcome(error),
      durationMs: Date.now() - started,
      completedAt: new Date().toISOString(),
      error: ((error as Error)?.message ?? String(error)).slice(0, 2_000),
    });
    throw error;
  }
}

async function llmChatWithKeyRotation(
  system: string,
  user: string,
  opts: LlmClientOptions,
  retryIndex: number,
  lineage: { lastAttemptId?: string },
): Promise<string> {
  const keys = splitKeys(opts.apiKey);
  if (keys.length > 1) {
    const start = keyCursor++;
    let lastErr: Error | undefined;
    for (let i = 0; i < keys.length; i++) {
      const idx = (start + i) % keys.length;
      try {
        return await trackedLlmAttempt(
          system,
          user,
          { ...opts, apiKey: keys[idx] },
          retryIndex,
          idx,
          lineage,
        );
      } catch (err) {
        lastErr = err as Error;
        if (!isRateLimitOrQuotaError(lastErr.message)) throw err;
        console.warn(`[llm] api key ${idx + 1}/${keys.length} rate-limited/quota — rotating to next key`);
      }
    }
    throw lastErr;
  }
  return trackedLlmAttempt(system, user, opts, retryIndex, 0, lineage);
}

async function llmChatSingle(system: string, user: string, opts: LlmClientOptions): Promise<string> {
  if (opts.api === 'anthropic') {
    return anthropicChat(system, user, opts);
  }
  if (opts.api === 'responses') {
    return openAiResponsesStreamChat(system, user, opts);
  }
  if (opts.baseUrl) {
    return openAiCompatStreamChat(system, user, opts);
  }
  return anthropicChat(system, user, opts);
}

async function anthropicChat(system: string, user: string, opts: LlmClientOptions): Promise<string> {
  throwIfCancelled(opts.signal);
  const hardLimitMs = maxTotalMs();
  const client = new Anthropic({ apiKey: opts.apiKey, baseURL: opts.baseUrl, timeout: hardLimitMs });
  // Match the MiniMax branch: stream (so multi-minute reasoning calls keep the
  // socket alive instead of dying as "fetch failed"), think by default, and use
  // a high output ceiling so reasoning + findings with fix blocks never truncate.
  const maxTokens = resolveMaxOutputTokens(opts.maxTokens);
  // Extended thinking is incompatible with an assistant prefill and needs real
  // output headroom — only enable it when there's room to think.
  const think = thinkingEnabled(opts) && maxTokens >= 16_000;
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: user }];
  const prefill = opts.json && !think;
  if (prefill) messages.push({ role: 'assistant', content: '{' });
  const defaultThinkingBudget = opts.model.startsWith('MiniMax-') ? 20_000 : 32_000;
  const configuredThinkingBudget = Number(process.env.ORVEX_ANTHROPIC_THINKING_BUDGET_TOKENS ?? defaultThinkingBudget);
  const thinkingBudget = Math.min(
    Number.isFinite(configuredThinkingBudget) && configuredThinkingBudget > 0
      ? configuredThinkingBudget
      : defaultThinkingBudget,
    maxTokens - 8_000,
  );
  const stream = client.messages.stream({
    model: opts.model,
    max_tokens: maxTokens,
    system,
    messages,
    ...(think
      ? { thinking: { type: 'enabled' as const, budget_tokens: thinkingBudget } }
      : {}),
    // Anthropic-compatible reasoning does not accept a temperature alongside
    // extended thinking. Other providers receive the explicit low temperature.
    ...(!think && opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
  });
  const startedAt = Date.now();
  let hitHardLimit = false;
  let cancelled = false;
  const cancelStream = () => {
    cancelled = true;
    stream.abort();
  };
  opts.signal?.addEventListener('abort', cancelStream, { once: true });
  if (opts.signal?.aborted) cancelStream();
  const hardTimer = setTimeout(() => {
    hitHardLimit = true;
    stream.abort();
  }, hardLimitMs);
  let response: Awaited<ReturnType<typeof stream.finalMessage>>;
  try {
    response = await stream.finalMessage();
  } catch (err) {
    if (cancelled || opts.signal?.aborted) throw new ReviewCancelledError();
    if (hitHardLimit) throw new Error(`LLM anthropic call exceeded ${hardLimitMs}ms wall-clock cap`);
    throw err;
  } finally {
    clearTimeout(hardTimer);
    opts.signal?.removeEventListener('abort', cancelStream);
  }
  if (response.usage) {
    opts.onUsage?.({
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      tokenSource: 'provider',
      provider: providerName(opts.baseUrl, opts.api),
      model: opts.model,
    });
  }
  if (response.stop_reason === 'max_tokens') {
    throw new Error('LLM response truncated (stop_reason=max_tokens); increase max tokens');
  }
  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('LLM returned no text content');
  }
  const reasoningChars = response.content.reduce(
    (total, block) => total + (block.type === 'thinking' ? block.thinking.length : 0),
    0,
  );
  const text = prefill ? `{${textBlock.text}` : textBlock.text;
  console.log(
    `[llm] model=${opts.model} api=anthropic thinking=${think ? 'on' : 'off'} ` +
      `reasoning=${reasoningChars}c answer=${text.length}c ${Math.round((Date.now() - startedAt) / 1000)}s`,
  );
  return text;
}

/**
 * OpenAI /v1/responses streaming — required by gpt-5.x / codex reasoning models.
 * Different shape from chat/completions: `instructions` (system) + `input`
 * (user), `reasoning.effort`, `max_output_tokens`, and SSE events keyed by a
 * `type` field (we accumulate `response.output_text.delta`). Reasoning content
 * is hidden by OpenAI — we only see the answer + a reasoning-token count. These
 * models can go SILENT for minutes while thinking at high effort, so the
 * inactivity timeout is deliberately generous (a silent think is not a stall).
 */
async function openAiResponsesStreamChat(system: string, user: string, opts: LlmClientOptions): Promise<string> {
  throwIfCancelled(opts.signal);
  const base = (opts.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
  const configuredTimeout = Number(process.env.ORVEX_RESPONSES_TIMEOUT_MS ?? 900_000);
  const timeoutMs =
    Number.isFinite(configuredTimeout) && configuredTimeout > 0
      ? Math.min(Math.max(Math.floor(configuredTimeout), 1_000), 900_000)
      : 900_000; // 15m inactivity backstop
  // Hard wall-clock cap: the inactivity timer never fires on a call that streams
  // continuously (a 490s over-thinking pass keeps resetting it), so a single call
  // could hang a review indefinitely. This bounds total call time regardless.
  const hardLimitMs = maxTotalMs();
  const controller = new AbortController();
  const unlinkAbort = linkAbortSignal(opts.signal, controller);
  let timer: ReturnType<typeof setTimeout>;
  let hardTimer: ReturnType<typeof setTimeout>;
  let timeoutReason: 'inactivity' | 'hard' | undefined;
  const armTimer = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timeoutReason = 'inactivity';
      controller.abort();
    }, timeoutMs);
  };
  const clearTimers = () => {
    clearTimeout(timer!);
    clearTimeout(hardTimer!);
  };
  armTimer();
  // Independent of stream activity: even continuous keepalives cannot extend
  // one billed provider attempt beyond five minutes.
  hardTimer = setTimeout(() => {
    timeoutReason = 'hard';
    controller.abort();
  }, hardLimitMs);

  const maxOut = resolveMaxOutputTokens(opts.maxTokens);
  const effort = opts.reasoningEffort ?? process.env.ORVEX_OPENAI_REASONING_EFFORT ?? 'high';

  let response: Response;
  try {
    response = await fetch(`${base}/responses`, {
      method: 'POST',
      signal: controller.signal,
      headers: { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({
        model: opts.model,
        instructions: system,
        input: user,
        // The responses endpoint is the gpt-5.x/codex reasoning shape, and those
        // models reject `temperature` with a 400 instead of ignoring it. Sending
        // it made every repeated aggregation sample fail and degrade to empty.
        ...(thinkingEnabled(opts) ? { reasoning: { effort } } : {}),
        max_output_tokens: maxOut,
        stream: true,
        ...(opts.json ? { text: { format: { type: 'json_object' } } } : {}),
      }),
    });
  } catch (err) {
    clearTimers();
    unlinkAbort();
    if (opts.signal?.aborted) throw new ReviewCancelledError();
    if ((err as Error).name === 'AbortError' || controller.signal.aborted) {
      if (timeoutReason === 'hard') throw new Error(`LLM responses call exceeded ${hardLimitMs}ms wall-clock cap`);
      throw new Error(`LLM responses request stalled (no data for ${timeoutMs}ms)`);
    }
    throw err;
  }

  if (!response.ok || !response.body) {
    const errorBody = response.ok ? 'no response body' : await response.text().catch(() => '');
    clearTimers();
    unlinkAbort();
    throw new Error(`LLM responses request failed (${response.status}): ${errorBody.slice(0, 500)}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const startedAt = Date.now();
  let buffer = '';
  let content = '';
  let reasoningTokens = 0;
  let inTok = 0;
  let outTok = 0;
  let failed: string | undefined;
  let incomplete: string | undefined;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      armTimer(); // any byte (delta, progress event, keepalive) counts as progress
      if (Date.now() - startedAt > hardLimitMs) {
        try { await reader.cancel(); } catch { /* best-effort */ }
        throw new Error(`LLM responses call exceeded ${hardLimitMs}ms wall-clock cap`);
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const raw of lines) {
        const line = raw.trim();
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '' || data === '[DONE]') continue;
        try {
          const evt = JSON.parse(data) as {
            type?: string;
            delta?: string;
            response?: {
              status?: string;
              incomplete_details?: { reason?: string };
              error?: { message?: string };
              usage?: { input_tokens?: number; output_tokens?: number; output_tokens_details?: { reasoning_tokens?: number } };
            };
            message?: string;
          };
          if (evt.type === 'response.output_text.delta' && typeof evt.delta === 'string') {
            content += evt.delta;
          } else if (evt.type === 'response.completed' || evt.type === 'response.incomplete') {
            const u = evt.response?.usage;
            if (u) {
              inTok = u.input_tokens ?? 0;
              outTok = u.output_tokens ?? 0;
              reasoningTokens = u.output_tokens_details?.reasoning_tokens ?? 0;
            }
            if (evt.type === 'response.incomplete') incomplete = evt.response?.incomplete_details?.reason ?? 'incomplete';
          } else if (evt.type === 'response.failed' || evt.type === 'error') {
            failed = evt.response?.error?.message ?? evt.message ?? 'response failed';
          }
        } catch {
          // partial/keepalive line — ignore, more will arrive
        }
      }
    }
  } catch (err) {
    if (opts.signal?.aborted) throw new ReviewCancelledError();
    if ((err as Error).name === 'AbortError' || controller.signal.aborted) {
      if (timeoutReason === 'hard') throw new Error(`LLM responses call exceeded ${hardLimitMs}ms wall-clock cap`);
      throw new Error(`LLM responses stream stalled (no data for ${timeoutMs}ms)`);
    }
    throw err;
  } finally {
    clearTimers();
    unlinkAbort();
  }

  console.log(
    `[llm] model=${opts.model} api=responses effort=${effort} reasoning=${reasoningTokens}tok ` +
      `answer=${content.length}c ${Math.round((Date.now() - startedAt) / 1000)}s`,
  );
  opts.onUsage?.({
    inputTokens: inTok || estimateTokens(system.length + user.length),
    outputTokens: outTok || estimateTokens(content.length),
    tokenSource: inTok && outTok ? 'provider' : 'estimate',
    provider: providerName(opts.baseUrl, opts.api),
    model: opts.model,
  });
  if (failed) throw new Error(`LLM responses stream failed: ${failed}`);
  // P1-4: truncation must be treated as a failure, not returned as success.
  // `response.incomplete` with non-empty content is the /v1/responses shape for
  // hitting max_output_tokens; mirror the chat path's `finish_reason==='length'`
  // and the Anthropic `stop_reason='max_tokens'` guards.
  if (incomplete) {
    throw new Error(`LLM responses truncated (${incomplete}); increase ORVEX_MAX_OUTPUT_TOKENS`);
  }
  // A max_output_tokens cutoff mid-reasoning yields an empty answer — surface it
  // as a retryable error rather than silently returning nothing.
  if (!content) throw new Error('LLM responses returned no text');
  return content;
}

/**
 * Streaming call to an OpenAI-compatible endpoint (MiniMax, etc.).
 *
 * Deep reasoning over a full-repo prompt can run for many minutes; a plain
 * non-streaming POST gets its connection dropped ("fetch failed") long before
 * the answer is ready. Streaming keeps the socket alive with a steady trickle
 * of tokens. The timeout is an INACTIVITY timer (reset on every chunk), so a
 * long-but-progressing reason never aborts — only a truly stalled socket does.
 *
 * `max_completion_tokens` includes reasoning and answer tokens. The shared 64k
 * default leaves substantial reasoning headroom without making gateways reserve
 * an uneconomical 128k allowance up front. Override with
 * ORVEX_MAX_OUTPUT_TOKENS when a provider genuinely needs a different ceiling.
 */
async function openAiCompatStreamChat(
  system: string,
  user: string,
  opts: LlmClientOptions,
): Promise<string> {
  throwIfCancelled(opts.signal);
  const controller = new AbortController();
  const unlinkAbort = linkAbortSignal(opts.signal, controller);
  const hardLimitMs = maxTotalMs();
  let timer: ReturnType<typeof setTimeout>;
  let hardTimer: ReturnType<typeof setTimeout>;
  let timeoutReason: 'inactivity' | 'hard' | undefined;
  const armTimer = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timeoutReason = 'inactivity';
      controller.abort();
    }, LLM_TIMEOUT_MS);
  };
  const clearTimers = () => {
    clearTimeout(timer!);
    clearTimeout(hardTimer!);
  };
  armTimer();
  hardTimer = setTimeout(() => {
    timeoutReason = 'hard';
    controller.abort();
  }, hardLimitMs);

  // Reasoning shares this budget with the answer.
  const maxOut = resolveMaxOutputTokens(opts.maxTokens);

  let response: Response;
  try {
    response = await fetch(`${opts.baseUrl!.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({
        model: opts.model,
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        max_completion_tokens: maxOut,
        stream: true,
        ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
        // OpenAI-style reasoning effort on the CHAT path — used by DeepSeek v4
        // ('low'..'max', verified live against api.deepseek.com) and OpenAI
        // models via OpenRouter. Only sent when the target sets it, so
        // MiniMax requests are unchanged. Never lower this on retries: Luna and
        // DeepSeek review stages are contractually run at max effort.
        ...(opts.reasoningEffort
          ? { reasoning_effort: opts.reasoningEffort }
          : {}),
        // MiniMax-M3 reasoning is controlled via chat_template_kwargs.thinking_mode
        // ('enabled' | 'adaptive' | 'disabled'). Default 'enabled' FORCES deep
        // reasoning on every call — 'adaptive' let the model decide and it
        // under-thought simpler-looking PRs (shorter runs, fewer findings).
        // The top-level `thinking.type` param is a different, narrower control
        // that rejects 'enabled' — don't use it.
        chat_template_kwargs: {
          thinking_mode: thinkingEnabled(opts) ? 'enabled' : 'disabled',
        },
        // Return reasoning in a dedicated reasoning_content stream (not inline
        // <think> tags), so the answer parses cleanly and we can measure it.
        reasoning_split: true,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
  } catch (err) {
    clearTimers();
    unlinkAbort();
    if (opts.signal?.aborted) throw new ReviewCancelledError();
    if ((err as Error).name === 'AbortError' || controller.signal.aborted) {
      if (timeoutReason === 'hard') throw new Error(`LLM chat call exceeded ${hardLimitMs}ms wall-clock cap`);
      throw new Error(`LLM request stalled (no data for ${LLM_TIMEOUT_MS}ms)`);
    }
    throw err;
  }

  if (!response.ok || !response.body) {
    const errorBody = response.ok ? 'no response body' : await response.text().catch(() => '');
    clearTimers();
    unlinkAbort();
    throw new Error(`LLM request failed (${response.status}): ${errorBody.slice(0, 500)}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const startedAt = Date.now();
  let buffer = '';
  let content = '';
  let reasoningChars = 0; // separated <think> stream (reasoning_split / M-series)
  let finishReason: string | undefined;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      armTimer(); // progress — reset the inactivity timer
      if (Date.now() - startedAt > hardLimitMs) {
        try { await reader.cancel(); } catch { /* best-effort */ }
        throw new Error(`LLM chat call exceeded ${hardLimitMs}ms wall-clock cap`);
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const raw of lines) {
        const line = raw.trim();
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '' || data === '[DONE]') continue;
        try {
          const chunk = JSON.parse(data) as {
            choices?: Array<{
              finish_reason?: string | null;
              native_finish_reason?: string | null;
              delta?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null };
            }>;
          };
          const choice = chunk.choices?.[0];
          if (choice?.delta?.content) content += choice.delta.content;
          if (choice?.delta?.reasoning_content) reasoningChars += choice.delta.reasoning_content.length;
          // OpenRouter normalizes reasoning into `delta.reasoning` (verified
          // live vs gpt-5.6-luna-pro) — without this, an OpenRouter model's
          // reasoning is invisible (logged 0c while it reasoned for minutes).
          if (choice?.delta?.reasoning) reasoningChars += choice.delta.reasoning.length;
          if (choice?.finish_reason) finishReason = choice.finish_reason;
          // OpenRouter's mapped finish_reason can say 'stop' while the
          // provider's native reason is 'length' — prefer the native one so
          // budget exhaustion is diagnosable and triggers the retry path.
          if (choice?.native_finish_reason && choice.native_finish_reason !== 'completed') {
            finishReason = choice.native_finish_reason;
          }
        } catch {
          // partial/keepalive line — ignore, more will arrive
        }
      }
    }
  } catch (err) {
    if (opts.signal?.aborted) throw new ReviewCancelledError();
    if ((err as Error).name === 'AbortError' || controller.signal.aborted) {
      if (timeoutReason === 'hard') throw new Error(`LLM chat call exceeded ${hardLimitMs}ms wall-clock cap`);
      throw new Error(`LLM stream stalled (no data for ${LLM_TIMEOUT_MS}ms)`);
    }
    throw err;
  } finally {
    clearTimers();
    unlinkAbort();
  }

  // Reasoning arrives either as a separate reasoning_content stream OR inline as
  // <think>…</think> in content. Sum both so the log reflects how much the model
  // actually reasoned — this is the ground truth behind "is it deeply thinking?".
  const inlineThinkChars = (content.match(/<think>[\s\S]*?<\/think>/gi) ?? []).reduce((n, b) => n + b.length, 0);
  const totalReasoning = reasoningChars + inlineThinkChars;
  const answerChars = stripThinking(content).length;
  console.log(
    `[llm] model=${opts.model} thinking=${thinkingEnabled(opts) ? 'on' : 'off'} ` +
      `reasoning=${totalReasoning}c answer=${answerChars}c ${Math.round((Date.now() - startedAt) / 1000)}s finish=${finishReason ?? 'stop'}`,
  );
  opts.onUsage?.({
    inputTokens: estimateTokens(system.length + user.length),
    outputTokens: estimateTokens(totalReasoning + answerChars),
    tokenSource: 'estimate',
    provider: providerName(opts.baseUrl, opts.api),
    model: opts.model,
  });

  const text = stripThinking(content);
  if (!text) throw new Error('LLM returned no text content');
  if (finishReason === 'length') {
    throw new Error('LLM response truncated (finish_reason=length); increase max tokens');
  }
  return text;
}

export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s.trim());
  } catch {
    return undefined;
  }
}

/**
 * Pull a JSON payload out of a model reply. Models wrap the object in prose, in
 * a ```json fence, or — for reviews of shell/nginx code — sometimes emit an
 * unrelated ```bash block FIRST (which naive `/```(?:json)?/` extraction would
 * grab and then crash JSON.parse on). Try, in order: an explicit json fence,
 * any fenced block that parses to an object, the outermost {...} span, then the
 * bare text. Throws only when nothing parses, so callers can retry or degrade.
 */
export function extractJsonLoose(text: string): unknown {
  const stripped = stripThinking(text);

  const jsonFence = stripped.match(/```json\s*([\s\S]*?)```/i);
  if (jsonFence) {
    const parsed = tryParse(jsonFence[1]);
    if (parsed !== undefined) return parsed;
  }

  for (const m of stripped.matchAll(/```[a-z]*\s*([\s\S]*?)```/gi)) {
    const parsed = tryParse(m[1]);
    if (parsed && typeof parsed === 'object') return parsed;
  }

  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start !== -1 && end > start) {
    const parsed = tryParse(stripped.slice(start, end + 1));
    if (parsed !== undefined) return parsed;
  }

  const bare = tryParse(stripped);
  if (bare !== undefined) return bare;

  throw new Error('LLM response contained no parseable JSON');
}
