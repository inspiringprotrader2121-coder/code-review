import { loadReviewRuntimeConfig } from '@orvex-review/config';
import type { RetryPolicy } from '../providers/types.js';
import type { LlmClientOptions } from './contracts.js';
import { ReviewCancelledError, isReviewCancelledError, throwIfCancelled } from './cancellation.js';
import {
  currentProviderCoordinator,
  isProviderAdmissionError,
  providerBucketForTarget,
  selectProviderKey,
  setProviderCooldown,
  splitApiKeys,
  waitForProviderAvailability,
  withProviderCallSlot,
} from './provider-admission.js';
import {
  allocateAttemptIndex,
  recordProviderAdmissionFailure,
  trackedLlmAttempt,
  type AttemptLineage,
} from './lifecycle.js';
import {
  isRetryableEmptyProviderResponse,
  isRetryableRateLimit,
  parseRetryAfterMs,
  sleep,
} from './retry-policy.js';
import { clockFor, maxTotalMs } from './support.js';
import { DeepSeekContinuationRequiredError } from './transports.js';

let keyCursor = 0;
// Primary max-reasoning can exhaust the shared completion budget with zero JSON.
// Continuations must finish the answer under load; keep them answer-only (thinking
// off) with enough wall/token headroom that a 3-PR burst does not mark required
// DeepSeek lenses incomplete after Luna already succeeded.
const MAX_DEEPSEEK_PREFIX_CONTINUATIONS = 2;
const DEEPSEEK_PREFIX_CONTINUATION_MAX_MS = 180_000;
const DEEPSEEK_PREFIX_CONTINUATION_MAX_TOKENS = 16_000;
const MAX_CONTINUATION_RATE_LIMIT_RETRIES = 2;

/**
 * One paid-call slot covers the primary attempt plus bounded DeepSeek
 * answer-only continuations so continuations never rejoin the back of a
 * multi-minute fleet wait queue after Luna already succeeded.
 * Key identity is fixed for the held slot (including continuations).
 */
async function llmChatHoldingProviderSlot(
  system: string,
  user: string,
  opts: LlmClientOptions,
  lineage: AttemptLineage,
  keyIndex: number,
): Promise<string> {
  const runtime = loadReviewRuntimeConfig();
  const baseMs = Math.min(60_000, Math.max(250, runtime.rateLimitBaseMs));
  const maxWaitMs = Math.min(300_000, Math.max(1_000, runtime.rateLimitMaxWaitMs));
  let continuationCount = 0;
  let continuation: LlmClientOptions['compatibleContinuation'];
  let continuationRateLimitAttempt = 0;
  for (;;) {
    throwIfCancelled(opts.signal);
    const attemptOpts: LlmClientOptions = {
      ...opts,
      compatibleContinuation: continuation,
      ...(continuation ? { thinking: false } : {}),
      hardLimitMs: continuation
        ? Math.min(opts.hardLimitMs ?? maxTotalMs(), DEEPSEEK_PREFIX_CONTINUATION_MAX_MS)
        : opts.hardLimitMs,
      maxTokens: continuation
        ? Math.min(
            opts.maxTokens ?? DEEPSEEK_PREFIX_CONTINUATION_MAX_TOKENS,
            DEEPSEEK_PREFIX_CONTINUATION_MAX_TOKENS,
          )
        : opts.maxTokens,
    };
    try {
      return await trackedLlmAttempt(
        system,
        user,
        attemptOpts,
        allocateAttemptIndex(lineage),
        keyIndex,
        lineage,
      );
    } catch (error) {
      const lastError =
        opts.signal?.aborted && !isReviewCancelledError(error)
          ? new ReviewCancelledError()
          : (error as Error);
      if (isReviewCancelledError(lastError) || opts.signal?.aborted)
        throw new ReviewCancelledError();
      if (lastError instanceof DeepSeekContinuationRequiredError) {
        if (continuationCount >= MAX_DEEPSEEK_PREFIX_CONTINUATIONS) {
          throw new Error(
            `DeepSeek response remained truncated after ${MAX_DEEPSEEK_PREFIX_CONTINUATIONS} bounded prefix continuation`,
          );
        }
        continuation = lastError.continuation;
        continuationCount++;
        continuationRateLimitAttempt = 0;
        console.warn(
          `[llm] DeepSeek max-reasoning output exhausted; continuing the same response (${continuationCount}/${MAX_DEEPSEEK_PREFIX_CONTINUATIONS})`,
        );
        continue;
      }
      if (continuation && isRetryableRateLimit(lastError.message)) {
        continuationRateLimitAttempt++;
        if (continuationRateLimitAttempt > MAX_CONTINUATION_RATE_LIMIT_RETRIES) {
          throw new Error(
            `429 DeepSeek continuation rate-limited after ${MAX_CONTINUATION_RATE_LIMIT_RETRIES} retries; ${lastError.message.slice(0, 160)}`,
          );
        }
        const advertised = parseRetryAfterMs(lastError.message);
        const waitMs = Math.min(
          (advertised ?? baseMs) + Math.floor(Math.random() * 1_000),
          maxWaitMs,
        );
        console.warn(
          `[llm] DeepSeek continuation rate-limited — holding provider slot ${Math.round(waitMs / 1000)}s then retrying (${continuationRateLimitAttempt}/${MAX_CONTINUATION_RATE_LIMIT_RETRIES})`,
        );
        await sleep(waitMs, opts.signal, clockFor(opts));
        continue;
      }
      throw lastError;
    }
  }
}

export async function llmChat(
  system: string,
  user: string,
  opts: LlmClientOptions,
): Promise<string> {
  const injectedPolicy: RetryPolicy | undefined = opts.dependencies?.retryPolicy;
  const runtime = loadReviewRuntimeConfig();
  const maxAttempts = Math.min(
    2,
    Math.max(1, Math.floor(injectedPolicy?.maxAttempts ?? runtime.rateLimitMaxRetries)),
  );
  const maxWaitMs = Math.min(
    300_000,
    Math.max(1_000, injectedPolicy?.maxWaitMs ?? runtime.rateLimitMaxWaitMs),
  );
  const baseMs = Math.min(60_000, Math.max(250, injectedPolicy?.baseMs ?? runtime.rateLimitBaseMs));
  // Long TPM windows (30–120s) must be waitable via config; do not silently clamp to 60s.
  const totalWaitBudgetMs = Math.min(
    900_000,
    Math.max(5_000, injectedPolicy?.totalWaitBudgetMs ?? runtime.rateLimitTotalWaitMs),
  );
  const provider = providerBucketForTarget(opts);
  const keys = splitApiKeys(opts.apiKey);
  if (keys.length === 0) throw new Error('LLM API key is required');
  const lineage: AttemptLineage = opts.attemptLineage ?? {};
  const coordinator = opts.dependencies?.admission ?? currentProviderCoordinator();
  let sleptMs = 0;
  let lastError: Error | undefined;
  let providerAttempt = 0;
  let lastLane = provider;
  while (providerAttempt < maxAttempts) {
    throwIfCancelled(opts.signal);
    const selection = await selectProviderKey(provider, keys, keyCursor++, coordinator);
    lastLane = selection.lane;
    let enteredProviderCall = false;
    try {
      return await withProviderCallSlot(
        provider,
        () => {
          enteredProviderCall = true;
          return llmChatHoldingProviderSlot(
            system,
            user,
            { ...opts, apiKey: selection.apiKey },
            lineage,
            selection.keyIndex,
          );
        },
        opts.signal,
        coordinator,
        { keyLane: selection.lane },
      );
    } catch (error) {
      lastError =
        opts.signal?.aborted && !isReviewCancelledError(error)
          ? new ReviewCancelledError()
          : (error as Error);
      if (!enteredProviderCall) recordProviderAdmissionFailure(opts, lineage, lastError);
      if (isReviewCancelledError(lastError) || opts.signal?.aborted)
        throw new ReviewCancelledError();
      // Admission misses are requeued by the executor; do not burn the short
      // provider rate-limit wait budget retrying into a saturated fleet.
      if (!enteredProviderCall && isProviderAdmissionError(lastError.message)) throw lastError;
      if (lastError instanceof DeepSeekContinuationRequiredError) {
        // Continuations are handled inside the held slot; surfacing here is a bug.
        throw lastError;
      }
      // Errors that already consumed the held-slot continuation path must not
      // restart the expensive primary attempt under a fresh admission.
      if (
        /continuation rate-limited|DeepSeek response remained truncated|bounded prefix continuation/i.test(
          lastError.message,
        )
      ) {
        throw lastError;
      }
      if (enteredProviderCall && isRetryableEmptyProviderResponse(lastError.message)) {
        throw lastError;
      }
      const retryableEmptyResponse = isRetryableEmptyProviderResponse(lastError.message);
      const retryable = isRetryableRateLimit(lastError.message) || retryableEmptyResponse;
      providerAttempt++;
      if (providerAttempt >= maxAttempts || !retryable) throw lastError;
      const advertised = parseRetryAfterMs(lastError.message);
      const cooldownMs = Math.min(
        300_000,
        Math.max(2_000, advertised ?? baseMs * 2 ** (providerAttempt - 1)),
      );
      await setProviderCooldown(selection.lane, cooldownMs, coordinator);

      // Multi-key: a window longer than maxWait on this key should not abort the
      // review when a sibling key is still cool — rotate immediately.
      if (advertised !== undefined && advertised > maxWaitMs) {
        const alternate = await selectProviderKey(provider, keys, keyCursor, coordinator);
        if (keys.length > 1 && alternate.lane !== selection.lane && alternate.cooldownMs <= 0) {
          console.warn(
            `[llm] rate limit window ${Math.round(advertised / 1000)}s on ${selection.lane} exceeds max wait — rotating to ${alternate.lane} without weakening the review`,
          );
          continue;
        }
        console.warn(
          `[llm] rate limit window ${Math.round(advertised / 1000)}s exceeds max wait ${Math.round(maxWaitMs / 1000)}s — failing fast instead of retrying into it`,
        );
        throw lastError;
      }
      const backoff = Math.min(baseMs * 2 ** (providerAttempt - 1), maxWaitMs);
      const jitter = Math.floor(Math.random() * 1_000);
      const waitMs = Math.min((advertised ?? backoff) + jitter, maxWaitMs);
      if (keys.length > 1) {
        const alternate = await selectProviderKey(provider, keys, keyCursor, coordinator);
        if (alternate.lane !== selection.lane && alternate.cooldownMs <= 0) {
          console.warn(
            `[llm] ${retryableEmptyResponse ? 'empty zero-usage response' : 'rate-limited'} on ${selection.lane} — rotating to cool key ${alternate.lane} (attempt ${providerAttempt}/${maxAttempts})`,
          );
          continue;
        }
      }
      if (sleptMs + waitMs > totalWaitBudgetMs) {
        console.warn(
          `[llm] rate-limit wait budget exhausted (${Math.round(sleptMs / 1000)}s slept of ${Math.round(totalWaitBudgetMs / 1000)}s) — failing so the job requeues instead of holding a worker slot`,
        );
        throw lastError;
      }
      sleptMs += waitMs;
      console.warn(
        `[llm] ${retryableEmptyResponse ? 'empty zero-usage response' : 'rate-limited'} — holding ${Math.round(waitMs / 1000)}s then retrying (attempt ${providerAttempt}/${maxAttempts}): ${lastError.message.slice(0, 140)}`,
      );
      await sleep(waitMs, opts.signal, clockFor(opts));
      await waitForProviderAvailability([lastLane], opts.signal, coordinator);
    }
  }
  throw lastError!;
}
