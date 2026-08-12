import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveCodexApiKeyConcurrency,
  resolveProviderConcurrency,
  resolveReviewWorkerConcurrency,
} from './runtime-limits.js';

test('runtime limits reserve one DeepSeek lane for each review slot', () => {
  assert.equal(resolveReviewWorkerConcurrency({}), 8);
  assert.equal(resolveCodexApiKeyConcurrency({}), 8);
  assert.equal(resolveProviderConcurrency('luna', {}), 8);
  assert.equal(resolveProviderConcurrency('deepseek', {}), 8);
  assert.equal(resolveProviderConcurrency('minimax', {}), 8);
});

test('worker ceiling stays operator-controlled while provider pools keep their capacity', () => {
  const env = {
    ORVEX_CODEX_CLI: '1',
    ORVEX_MAX_CONCURRENT_REVIEWS: '4',
    ORVEX_CODEX_APIKEY_CONCURRENCY: '8',
  };
  assert.equal(resolveReviewWorkerConcurrency(env), 4);
  assert.equal(resolveCodexApiKeyConcurrency(env), 8);
  assert.equal(resolveProviderConcurrency('luna', env), 8);
});

test('provider overrides and upper bounds remain independent', () => {
  const env = {
    ORVEX_CODEX_CLI: '1',
    ORVEX_CODEX_APIKEY_CONCURRENCY: '999',
    ORVEX_PROVIDER_CONCURRENCY_LUNA: '3',
  };
  assert.equal(resolveCodexApiKeyConcurrency(env), 100);
  assert.equal(resolveProviderConcurrency('luna', env), 3);
  assert.equal(resolveProviderConcurrency('deepseek', env), 100);
});

test('invalid runtime limits fall back without disabling work', () => {
  const env = {
    ORVEX_MAX_CONCURRENT_REVIEWS: 'invalid',
    ORVEX_CODEX_APIKEY_CONCURRENCY: 'invalid',
    ORVEX_PROVIDER_CONCURRENCY_MINIMAX: 'invalid',
  };
  assert.equal(resolveReviewWorkerConcurrency(env), 8);
  assert.equal(resolveCodexApiKeyConcurrency(env), 8);
  assert.equal(resolveProviderConcurrency('minimax', env), 8);
});
