import { throwIfCancelled, ReviewCancelledError } from './cancellation.js';
import { systemClock } from './contracts.js';
import type { Clock } from '../providers/types.js';

export function isRateLimitOrQuotaError(message: string): boolean {
  return /\b429\b|\b529\b|overloaded|\b402\b[^\n]*(?:credit|quota|payment)|rate.?limit|usage limit|quota|token plan|insufficient|more credits?/i.test(
    message,
  );
}

export function parseRetryAfterMs(message: string): number | undefined {
  const ms = /try again in\s*([\d.]+)\s*ms\b/i.exec(message);
  if (ms) return Math.ceil(parseFloat(ms[1]));
  const retryAfter = /retry[-\s]?after[:\s]+([\d.]+)\s*(?:s(?:ec(?:onds?)?)?)?\b/i.exec(message);
  if (retryAfter) return Math.ceil(parseFloat(retryAfter[1]) * 1000);
  const seconds = /try again in\s*([\d.]+)\s*s(?:ec(?:onds?)?)?\b/i.exec(message);
  if (seconds) return Math.ceil(parseFloat(seconds[1]) * 1000);
  return undefined;
}

export function isOversizedModelRequest(message: string): boolean {
  return /request too large|context[_ ]length[_ ]exceeded|maximum context length|string_above_max_length|prompt is too long|input\s+tokens?\s+exceed/i.test(
    message,
  );
}

export function isRetryableRateLimit(message: string): boolean {
  const status = /\brequest failed\s*\(\s*(\d{3})\b/i.exec(message)?.[1];
  if (status === '402' && /credit|insufficient|afford|top-?up/i.test(message)) return false;
  if (/insufficient_quota|exceeded your current quota|billing_hard_limit/i.test(message))
    return false;
  if (isOversizedModelRequest(message)) return false;
  return /\b429\b|\b529\b|rate.?limit|tokens? per min|requests? per min|\bTPM\b|\bRPM\b|try again in|overloaded|please try again|token plan|usage limit/i.test(
    message,
  );
}

/** True when the provider is in a recoverable rolling token window, not a hard quota. */
export function isTpmWindowError(message: string): boolean {
  return (
    isRetryableRateLimit(message) &&
    /\bTPM\b|tokens? per min/i.test(message) &&
    !isOversizedModelRequest(message)
  );
}

/**
 * How long to pause before retrying a 429. A TPM window advertised as a few
 * hundred milliseconds still needs a floor so concurrent reviews do not
 * stampede back into the same exhausted minute.
 */
export function rateLimitRetryWaitMs(
  message: string,
  backoffMs: number,
  maxWaitMs: number,
): number {
  const advertised = parseRetryAfterMs(message);
  const floor = isTpmWindowError(message) ? 2_000 : 0;
  const cap = Math.max(1, Math.floor(maxWaitMs));
  return Math.min(Math.max(advertised ?? backoffMs, floor), cap);
}

export const RETRYABLE_EMPTY_PROVIDER_RESPONSE =
  'LLM provider returned empty response with zero usage';

export function isRetryableEmptyProviderResponse(message: string): boolean {
  return message.trim() === RETRYABLE_EMPTY_PROVIDER_RESPONSE;
}

export function providerCooldownForFailure(message: string): number | undefined {
  if (isRetryableEmptyProviderResponse(message)) return 2_000;
  if (isOversizedModelRequest(message)) return undefined;
  // An active stream reaching its per-request wall cap is prompt/model work,
  // not evidence that the provider fleet is unavailable. Cooling the whole
  // provider here makes the next required shard fail before any HTTP request.
  if (/wall-clock cap/i.test(message)) return undefined;
  if (/insufficient_quota|exceeded your current quota|billing_hard_limit/i.test(message))
    return 300_000;
  const status = /\brequest failed\s*\(\s*(\d{3})\b/i.exec(message)?.[1];
  if (status === '402' && /credit|insufficient|afford|top-?up/i.test(message)) return 300_000;
  const advertised = parseRetryAfterMs(message);
  if (advertised !== undefined) return Math.min(300_000, Math.max(2_000, advertised));
  if (isRetryableRateLimit(message)) return 2_000;
  if (
    /\b(?:408|425|5\d\d)\b|fetch failed|econn|socket hang|timed?\s*out|stalled|produced no output/i.test(
      message,
    )
  )
    return 30_000;
  return undefined;
}

export function sleep(ms: number, signal?: AbortSignal, clock: Clock = systemClock): Promise<void> {
  return new Promise((resolve, reject) => {
    throwIfCancelled(signal);
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = () => {
      clock.clearTimeout(timer);
      reject(new ReviewCancelledError());
    };
    timer = clock.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}
