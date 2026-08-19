import { JsonContractMismatchError } from '../llm-client.js';
import { isReviewCancelledError } from '../llm/cancellation.js';
import { isRateLimitOrQuotaError } from '../llm/retry-policy.js';
import { isTransientLlmError } from '../llm.js';
import type { AgenticFailureReason } from './types.js';

export function isAgenticParseError(error: unknown): boolean {
  if (error instanceof JsonContractMismatchError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /no parseable JSON|JSON contract mismatch|no usable findings|review JSON|responses? (?:stream )?(?:remained )?truncated|bounded prefix continuation/i.test(
    message,
  );
}

export function extractAgenticParseText(error: unknown): string {
  return error instanceof JsonContractMismatchError ? error.text : '';
}

export function isAgenticTransientError(error: unknown): boolean {
  if (isReviewCancelledError(error)) return true;
  const message = error instanceof Error ? error.message : String(error);
  return isTransientLlmError(message);
}

export function classifyAgenticProviderFailure(error: unknown): AgenticFailureReason {
  if (isReviewCancelledError(error)) return 'cancelled';
  const message = error instanceof Error ? error.message : String(error);
  if (/cancelled/i.test(message)) return 'cancelled';
  if (isRateLimitOrQuotaError(message) || /\b429\b/.test(message)) return 'rate_limit';
  if (/timed?\s?out|stalled|wall-clock cap|inactivity/i.test(message)) return 'timeout';
  if (isAgenticParseError(error)) return 'parse_failure';
  return 'provider_error';
}
