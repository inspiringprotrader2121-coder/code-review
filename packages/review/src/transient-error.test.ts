import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTransientLlmError } from './llm.js';
import { isRateLimitOrQuotaError, resolveMaxOutputTokens } from './llm-client.js';

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
