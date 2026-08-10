import { loadReviewRuntimeConfig } from '@orvex-review/config';
import type { RetryPolicy } from '../providers/types.js';
import type { LlmClientOptions } from './contracts.js';
import { ReviewCancelledError, isReviewCancelledError, throwIfCancelled } from './cancellation.js';
import {
  currentProviderCoordinator,
  providerBucketForTarget,
  setProviderCooldown,
  waitForProviderAvailability,
  withProviderCallSlot,
} from './provider-admission.js';
import {
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
import { clockFor } from './support.js';

let keyCursor = 0;

function splitKeys(apiKey: string): string[] {
  return apiKey
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);
}

async function llmChatWithKeyRotation(
  system: string,
  user: string,
  opts: LlmClientOptions,
  attemptIndex: number,
  lineage: AttemptLineage,
): Promise<string> {
  const keys = splitKeys(opts.apiKey);
  const keyIndex = keys.length > 1 ? keyCursor++ % keys.length : 0;
  const apiKey = keys[keyIndex];
  if (!apiKey) throw new Error('LLM API key is required');
  return trackedLlmAttempt(system, user, { ...opts, apiKey }, attemptIndex, keyIndex, lineage);
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
  const totalWaitBudgetMs = Math.min(
    60_000,
    Math.max(5_000, injectedPolicy?.totalWaitBudgetMs ?? runtime.rateLimitTotalWaitMs),
  );
  const provider = providerBucketForTarget(opts);
  const lineage: AttemptLineage = {};
  let sleptMs = 0;
  let lastError: Error | undefined;
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
        opts.dependencies?.admission ?? currentProviderCoordinator(),
      );
    } catch (error) {
      lastError =
        opts.signal?.aborted && !isReviewCancelledError(error)
          ? new ReviewCancelledError()
          : (error as Error);
      if (!enteredProviderCall) recordProviderAdmissionFailure(opts, attempt, lineage, lastError);
      if (isReviewCancelledError(lastError) || opts.signal?.aborted)
        throw new ReviewCancelledError();
      const retryableEmptyResponse = isRetryableEmptyProviderResponse(lastError.message);
      if (
        attempt === maxAttempts - 1 ||
        (!isRetryableRateLimit(lastError.message) && !retryableEmptyResponse)
      )
        throw lastError;
      const advertised = parseRetryAfterMs(lastError.message);
      if (advertised !== undefined && advertised > maxWaitMs) {
        console.warn(
          `[llm] rate limit window ${Math.round(advertised / 1000)}s exceeds max wait ${Math.round(maxWaitMs / 1000)}s — failing fast instead of retrying into it`,
        );
        throw lastError;
      }
      const backoff = Math.min(baseMs * 2 ** attempt, maxWaitMs);
      const jitter = Math.floor(Math.random() * 1_000);
      const waitMs = Math.min((advertised ?? backoff) + jitter, maxWaitMs);
      if (sleptMs + waitMs > totalWaitBudgetMs) {
        console.warn(
          `[llm] rate-limit wait budget exhausted (${Math.round(sleptMs / 1000)}s slept of ${Math.round(totalWaitBudgetMs / 1000)}s) — failing so the job requeues instead of holding a worker slot`,
        );
        throw lastError;
      }
      sleptMs += waitMs;
      await setProviderCooldown(
        provider,
        waitMs,
        opts.dependencies?.admission ?? currentProviderCoordinator(),
      );
      console.warn(
        `[llm] ${retryableEmptyResponse ? 'empty zero-usage response' : 'rate-limited'} — holding ${Math.round(waitMs / 1000)}s then retrying (attempt ${attempt + 1}/${maxAttempts}): ${lastError.message.slice(0, 140)}`,
      );
      await sleep(waitMs, opts.signal, clockFor(opts));
      await waitForProviderAvailability(
        [provider],
        opts.signal,
        opts.dependencies?.admission ?? currentProviderCoordinator(),
      );
    }
  }
  throw lastError!;
}
