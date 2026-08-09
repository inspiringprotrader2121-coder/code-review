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
  return /\b429\b|\b529\b|rate.?limit|tokens? per min|requests? per min|\bTPM\b|\bRPM\b|try again in|overloaded|please try again/i.test(
    message,
  );
}

export function providerCooldownForFailure(message: string): number | undefined {
  if (isOversizedModelRequest(message)) return undefined;
  if (/insufficient_quota|exceeded your current quota|billing_hard_limit/i.test(message))
    return 300_000;
  const status = /\brequest failed\s*\(\s*(\d{3})\b/i.exec(message)?.[1];
  if (status === '402' && /credit|insufficient|afford|top-?up/i.test(message)) return 300_000;
  const advertised = parseRetryAfterMs(message);
  if (advertised !== undefined) return Math.min(300_000, Math.max(2_000, advertised));
  if (isRetryableRateLimit(message)) return 2_000;
  if (
    /\b(?:408|425|5\d\d)\b|fetch failed|econn|socket hang|wall-clock cap|timed?\s*out|stalled|produced no output/i.test(
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
