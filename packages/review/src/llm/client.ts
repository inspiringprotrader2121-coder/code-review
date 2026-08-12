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
  lineage: AttemptLineage,
): Promise<string> {
  const keys = splitKeys(opts.apiKey);
  const keyIndex = keys.length > 1 ? keyCursor++ % keys.length : 0;
  const apiKey = keys[keyIndex];
  if (!apiKey) throw new Error('LLM API key is required');
  return trackedLlmAttempt(
    system,
    user,
    { ...opts, apiKey },
    allocateAttemptIndex(lineage),
    keyIndex,
    lineage,
  );
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
  const lineage: AttemptLineage = opts.attemptLineage ?? {};
  let sleptMs = 0;
  let lastError: Error | undefined;
  let providerAttempt = 0;
  let continuationCount = 0;
  let continuation: LlmClientOptions['compatibleContinuation'];
  while (providerAttempt < maxAttempts) {
    throwIfCancelled(opts.signal);
    const attemptOpts: LlmClientOptions = {
      ...opts,
      compatibleContinuation: continuation,
      // Reasoning already landed in the assistant prefix. Forcing thinking off
      // stops a second max-reasoning burn and leaves the budget for JSON.
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
    let enteredProviderCall = false;
    try {
      return await withProviderCallSlot(
        provider,
        () => {
          enteredProviderCall = true;
          return llmChatWithKeyRotation(system, user, attemptOpts, lineage);
        },
        opts.signal,
        opts.dependencies?.admission ?? currentProviderCoordinator(),
      );
    } catch (error) {
      lastError =
        opts.signal?.aborted && !isReviewCancelledError(error)
          ? new ReviewCancelledError()
          : (error as Error);
      if (!enteredProviderCall) recordProviderAdmissionFailure(attemptOpts, lineage, lastError);
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
        console.warn(
          `[llm] DeepSeek max-reasoning output exhausted; continuing the same response (${continuationCount}/${MAX_DEEPSEEK_PREFIX_CONTINUATIONS})`,
        );
        continue;
      }
      const retryableEmptyResponse = isRetryableEmptyProviderResponse(lastError.message);
      const retryable = isRetryableRateLimit(lastError.message) || retryableEmptyResponse;
      if (continuation) {
        if (retryable) {
          const advertised = parseRetryAfterMs(lastError.message);
          const cooldownMs = Math.min(advertised ?? baseMs, maxWaitMs);
          await setProviderCooldown(
            provider,
            cooldownMs,
            opts.dependencies?.admission ?? currentProviderCoordinator(),
          ).catch(() => undefined);
        }
        throw lastError;
      }
      providerAttempt++;
      if (providerAttempt >= maxAttempts || !retryable) throw lastError;
      const advertised = parseRetryAfterMs(lastError.message);
      if (advertised !== undefined && advertised > maxWaitMs) {
        console.warn(
          `[llm] rate limit window ${Math.round(advertised / 1000)}s exceeds max wait ${Math.round(maxWaitMs / 1000)}s — failing fast instead of retrying into it`,
        );
        throw lastError;
      }
      const backoff = Math.min(baseMs * 2 ** (providerAttempt - 1), maxWaitMs);
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
        `[llm] ${retryableEmptyResponse ? 'empty zero-usage response' : 'rate-limited'} — holding ${Math.round(waitMs / 1000)}s then retrying (attempt ${providerAttempt}/${maxAttempts}): ${lastError.message.slice(0, 140)}`,
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
