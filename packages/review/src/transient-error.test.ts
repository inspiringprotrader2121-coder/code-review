import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTransientLlmError } from './llm.js';
import { isRateLimitOrQuotaError } from './llm-client.js';

test('provider failover fires on rate-limit/quota errors specifically (narrower than transient)', () => {
  // These trigger the MiniMax→fallback/Anthropic failover.
  assert.ok(isRateLimitOrQuotaError('LLM request failed (429): rate_limit_error'));
  assert.ok(isRateLimitOrQuotaError('Token Plan usage limit reached (2056)'));
  assert.ok(isRateLimitOrQuotaError('insufficient quota'));
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
});

test('does NOT treat a genuine parse/model failure as transient (those degrade to empty)', () => {
  assert.ok(!isTransientLlmError('LLM response contained no parseable JSON'));
  assert.ok(!isTransientLlmError('Unexpected token in JSON'));
  assert.ok(!isTransientLlmError('LLM returned no text content'));
});
