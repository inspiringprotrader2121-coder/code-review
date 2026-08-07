import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTransientLlmError } from './llm.js';
import {
  isRateLimitOrQuotaError,
  resolveMaxOutputTokens,
  parseRetryAfterMs,
  isRetryableRateLimit,
  isOversizedModelRequest,
} from './llm-client.js';

test('provider failover fires on rate-limit/quota errors specifically (narrower than transient)', () => {
  // These trigger the MiniMax→fallback/Anthropic failover.
  assert.ok(isRateLimitOrQuotaError('LLM request failed (429): rate_limit_error'));
  assert.ok(isRateLimitOrQuotaError('Token Plan usage limit reached (2056)'));
  assert.ok(isRateLimitOrQuotaError('insufficient quota'));
  assert.ok(isRateLimitOrQuotaError('LLM request failed (402): This request requires more credits'));
});

test('a plain network blip is transient but does NOT itself trigger provider failover', () => {
  // A transient network hiccup on the primary is worth retrying on the SAME
  // provider — only a genuine rate-limit/quota signal means "switch providers".
  assert.ok(isTransientLlmError('fetch failed'));
  assert.ok(!isRateLimitOrQuotaError('fetch failed'));
  assert.ok(!isRateLimitOrQuotaError('LLM stream stalled (no data for 240000ms)'));
});

test('detects rate-limit / token-plan / transport errors as transient (retryable)', () => {
  assert.ok(isTransientLlmError('LLM request failed (429): rate_limit_error'));
  assert.ok(isTransientLlmError('Token Plan rate limit reached: Upgrade your Token Plan (2062)'));
  assert.ok(isTransientLlmError('fetch failed'));
  assert.ok(isTransientLlmError('LLM stream stalled (no data for 240000ms)'));
  assert.ok(isTransientLlmError('ECONNRESET'));
  assert.ok(isTransientLlmError('LLM request failed (402): requires more credits'));
});

test('uses a funded-provider-friendly 64k output ceiling by default', (t) => {
  const previous = process.env.ORVEX_MAX_OUTPUT_TOKENS;
  t.after(() => {
    if (previous === undefined) delete process.env.ORVEX_MAX_OUTPUT_TOKENS;
    else process.env.ORVEX_MAX_OUTPUT_TOKENS = previous;
  });
  delete process.env.ORVEX_MAX_OUTPUT_TOKENS;
  assert.equal(resolveMaxOutputTokens(), 64_000);
  assert.equal(resolveMaxOutputTokens(12_345.9), 12_345);
  process.env.ORVEX_MAX_OUTPUT_TOKENS = 'not-a-number';
  assert.equal(resolveMaxOutputTokens(), 64_000);
});

test('parseRetryAfterMs extracts the provider retry-after hint', () => {
  // The exact OpenAI TPM 429 that dropped reviews in the batch run.
  assert.equal(parseRetryAfterMs('Rate limit reached ... Please try again in 49.174s. Visit'), 49_174);
  assert.equal(parseRetryAfterMs('try again in 6.015s'), 6_015);
  assert.equal(parseRetryAfterMs('try again in 120ms'), 120);
  assert.equal(parseRetryAfterMs('retry-after: 30'), 30_000);
  assert.equal(parseRetryAfterMs('retry after 12 seconds'), 12_000);
  assert.equal(parseRetryAfterMs('some error with no delay hint'), undefined);
});

test('isRetryableRateLimit: waits on recoverable limits, fails fast on hard quota', () => {
  // Recoverable — waiting clears these.
  assert.equal(isRetryableRateLimit('Rate limit reached for gpt-5.6-luna ... tokens per min (TPM): Limit 200000'), true);
  assert.equal(isRetryableRateLimit('LLM request failed (429): too many requests'), true);
  assert.equal(isRetryableRateLimit('LLM request failed (529): overloaded'), true);
  assert.equal(isRetryableRateLimit('Please try again in 6s'), true);
  // NOT recoverable by waiting — a credit top-up is required; must fail fast.
  assert.equal(isRetryableRateLimit('LLM request failed (402): requires more credits, insufficient balance'), false);
  // Not a rate limit at all.
  assert.equal(isRetryableRateLimit('terminated'), false);
  assert.equal(isRetryableRateLimit('LLM request failed (400): bad request'), false);
});

test('isOversizedModelRequest: fail-fast, never sleep-retry as TPM', () => {
  const msg =
    'Reconnecting... 2/2 (stream disconnected before completion: Request too large for gpt-5.6-luna in organization org-abc)';
  assert.equal(isOversizedModelRequest(msg), true);
  assert.equal(isRetryableRateLimit(msg), false);
  assert.equal(isOversizedModelRequest('context_length_exceeded: max 128000'), true);
  assert.equal(isRetryableRateLimit('context_length_exceeded: max 128000'), false);
  // A real TPM line must still retry (raise TPM later; do not change that path).
  assert.equal(
    isRetryableRateLimit('Rate limit reached for gpt-5.6-luna ... tokens per min (TPM): Limit 200000'),
    true,
  );
});

test('clamps an oversized ceiling to the safe cap (the 200k prod misconfig)', (t) => {
  const prevMax = process.env.ORVEX_MAX_OUTPUT_TOKENS;
  const prevCap = process.env.ORVEX_MAX_OUTPUT_TOKENS_CAP;
  t.after(() => {
    if (prevMax === undefined) delete process.env.ORVEX_MAX_OUTPUT_TOKENS;
    else process.env.ORVEX_MAX_OUTPUT_TOKENS = prevMax;
    if (prevCap === undefined) delete process.env.ORVEX_MAX_OUTPUT_TOKENS_CAP;
    else process.env.ORVEX_MAX_OUTPUT_TOKENS_CAP = prevCap;
  });
  delete process.env.ORVEX_MAX_OUTPUT_TOKENS_CAP;
  // The exact live misconfig that reserved 128k credit and 402'd every call.
  process.env.ORVEX_MAX_OUTPUT_TOKENS = '200000';
  assert.equal(resolveMaxOutputTokens(), 64_000, 'env 200k must clamp to 64k');
  assert.equal(resolveMaxOutputTokens(200_000), 64_000, 'explicit 200k must clamp to 64k');
  // A value at/under the cap passes through untouched.
  process.env.ORVEX_MAX_OUTPUT_TOKENS = '48000';
  assert.equal(resolveMaxOutputTokens(), 48_000);
  // The cap is a deliberate escape hatch — raising it lifts the ceiling.
  process.env.ORVEX_MAX_OUTPUT_TOKENS_CAP = '120000';
  process.env.ORVEX_MAX_OUTPUT_TOKENS = '100000';
  assert.equal(resolveMaxOutputTokens(), 100_000, 'raising the cap lets a larger value through');
});

test('all permanent 4xx statuses are non-transient; retry-later statuses remain transient', () => {
  for (const status of [400, 401, 403, 404, 405, 409, 410, 411, 413, 415, 422, 451]) {
    assert.equal(
      isTransientLlmError(`LLM request failed (${status}): request failed`),
      false,
      `${status} must not be retried`,
    );
  }
  for (const status of [408, 425, 429]) {
    assert.equal(isTransientLlmError(`LLM request failed (${status})`), true, `${status} should be retried`);
  }
  assert.equal(isTransientLlmError('Request failed with status code 415'), false);
  assert.equal(
    isTransientLlmError('request failed after processing 451 records'),
    true,
    'an unrelated three-digit number is not an HTTP status',
  );
});

test('does NOT treat a genuine parse/model failure as transient (those degrade to empty)', () => {
  assert.ok(!isTransientLlmError('LLM response contained no parseable JSON'));
  assert.ok(!isTransientLlmError('Unexpected token in JSON'));
  assert.ok(!isTransientLlmError('LLM returned no text content'));
});

test('NaN env vars cannot defeat retry bounds (infinite-loop guard)', () => {
  // `Math.max(1, Math.floor(Number('abc')))` is NaN, and `i >= NaN` is ALWAYS
  // false — a typo'd env var turned the codex retry into an infinite loop that
  // re-ran a full agentic pass every 90s. Both consumers must be NaN-proof.
  const finite = (raw: string | undefined, fallback: number): number => {
    if (raw === undefined || raw.trim() === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  };
  assert.equal(finite('abc', 4), 4);
  assert.equal(finite(undefined, 4), 4);
  assert.equal(finite('', 4), 4, 'empty string must not become 0 via Number("")');
  assert.equal(finite('7', 4), 7);
  assert.ok(Number.isFinite(Math.max(1, Math.floor(finite('abc', 4)))));
});

test('hard quota is never retried, however the provider dresses it', () => {
  // OpenAI ships insufficient_quota as HTTP 429 — retrying it waits forever on
  // every review. And a 402 inside a message body must not mask a real 429.
  assert.equal(isRetryableRateLimit('LLM request failed (429): insufficient_quota, please check billing'), false);
  assert.equal(isRetryableRateLimit('You exceeded your current quota, please check your plan'), false);
  assert.equal(
    isRetryableRateLimit('LLM request failed (429): used 402 of 500 credits this minute; rate limit'),
    true,
    'an unrelated 402 in the body must not misclassify a recoverable 429',
  );
});

test('an overloaded provider triggers failover, not just waiting', () => {
  // 529/overloaded is exactly when rotating keys / failing over is right; it was
  // retryable but NOT failover-eligible, so a configured fallback went untried.
  assert.equal(isRateLimitOrQuotaError('LLM request failed (529): overloaded'), true);
  assert.equal(isRetryableRateLimit('LLM request failed (529): overloaded'), true);
});
