import assert from 'node:assert/strict';
import test from 'node:test';
import {
  loadGitHubRuntimeConfig,
  loadReviewRuntimeConfig,
  loadRulesRuntimeConfig,
} from './index.js';

test('review runtime defaults preserve production safety limits', () => {
  const config = loadReviewRuntimeConfig({});
  assert.equal(config.openAiReasoningEffort, 'high');
  assert.equal(config.llmTimeoutMs, 240_000);
  assert.equal(config.llmMaxTotalMs, 300_000);
  assert.equal(config.codexTimeoutMs, 480_000);
  assert.equal(config.codexInactivityTimeoutMs, 300_000);
  assert.equal(config.maxFindings, 25);
  assert.equal(config.reviewWorkerConcurrency, 8);
  assert.equal(config.codexApiKeyConcurrency, 8);
  assert.equal(config.providerConcurrency('luna'), 8);
  assert.equal(config.providerConcurrency('deepseek'), 24);
  assert.equal(config.promptChangedChars, 16_000);
  assert.equal(config.promptRelatedChars, 6_000);
  assert.equal(config.promptOtherChars, 2_000);
  assert.equal(config.reviewInput.maxFileBytes, 1_000_000);
  assert.equal(config.reviewInput.maxFiles, 3_000);
  assert.deepEqual(config.codexAllowedRepos, []);
  assert.ok(Object.isFrozen(config));
  assert.ok(Object.isFrozen(config.childProcessEnvironment));
});

test('pinned Luna pricing cannot inherit stale generic OpenAI rates', () => {
  const config = loadReviewRuntimeConfig({
    ORVEX_OPENAI_COST_INPUT_PER_M: '1',
    ORVEX_OPENAI_CACHED_INPUT_COST_PER_M: '0.1',
    ORVEX_OPENAI_COST_OUTPUT_PER_M: '6',
  });

  assert.deepEqual(config.pricing.openai, { input: 1, cachedInput: 0.1, output: 6 });
  assert.deepEqual(config.pricing.modelRates['gpt-5.6-luna'], {
    input: 0.2,
    cachedInput: 0.02,
    output: 1.2,
  });
});

test('review runtime preserves max reasoning, bounded timers, and pinned child environment', () => {
  const config = loadReviewRuntimeConfig({
    ORVEX_OPENAI_REASONING_EFFORT: 'max',
    ORVEX_LLM_TIMEOUT_MS: '9999999',
    ORVEX_LLM_MAX_TOTAL_MS: '1',
    ORVEX_CODEX_TIMEOUT_MS: '1',
    ORVEX_CODEX_INACTIVITY_TIMEOUT_MS: '9999999',
    ORVEX_CODEX_CLI: '1',
    ORVEX_MAX_CONCURRENT_REVIEWS: '4',
    ORVEX_CODEX_APIKEY_CONCURRENCY: '9',
    ORVEX_PROVIDER_CONCURRENCY_LUNA: '7',
    ORVEX_CODEX_CLI_REPOS: 'Acme/Widgets, acme/api ,',
    PATH: '/usr/bin',
    GITHUB_APP_PRIVATE_KEY: 'must-not-cross-child-boundary',
  });
  assert.equal(config.openAiReasoningEffort, 'max');
  assert.equal(config.llmTimeoutMs, 900_000);
  assert.equal(config.llmMaxTotalMs, 30_000);
  assert.equal(config.codexTimeoutMs, 60_000);
  assert.equal(config.codexInactivityTimeoutMs, 60_000);
  assert.equal(config.reviewWorkerConcurrency, 4);
  assert.equal(config.codexApiKeyConcurrency, 9);
  assert.equal(config.providerConcurrency('luna'), 7);
  assert.deepEqual(config.codexAllowedRepos, ['acme/widgets', 'acme/api']);
  assert.deepEqual(config.childProcessEnvironment, { PATH: '/usr/bin' });
});

test('production capacity profile reserves eight reviews and 24 DeepSeek stages', () => {
  const config = loadReviewRuntimeConfig({
    ORVEX_CODEX_CLI: '1',
    ORVEX_MAX_CONCURRENT_REVIEWS: '8',
    ORVEX_CODEX_APIKEY_CONCURRENCY: '8',
    ORVEX_PROVIDER_CONCURRENCY_LUNA: '8',
    ORVEX_PROVIDER_CONCURRENCY_DEEPSEEK: '24',
    ORVEX_PROVIDER_CONCURRENCY_MINIMAX: '8',
    ORVEX_VERIFY_CONCURRENCY: '1',
    ORVEX_REVIEW_CONCURRENCY: '3',
  });

  assert.equal(config.reviewWorkerConcurrency, 8);
  assert.equal(config.codexApiKeyConcurrency, 8);
  assert.equal(config.providerConcurrency('luna'), 8);
  assert.equal(config.providerConcurrency('deepseek'), 24);
  assert.equal(config.providerConcurrency('minimax'), 8);
  assert.equal(config.verifyConcurrency, 1);
  assert.equal(config.execution.concurrency, 3);
});

test('supporting context cannot override the diff-first production ceiling', () => {
  const config = loadReviewRuntimeConfig({
    ORVEX_MAX_CHANGED_CHARS: '999999',
    ORVEX_MAX_RELATED_CHARS: '999999',
    ORVEX_MAX_OTHER_CHARS: '999999',
  });
  assert.equal(config.promptChangedChars, 16_000);
  assert.equal(config.promptRelatedChars, 6_000);
  assert.equal(config.promptOtherChars, 2_000);
});

test('review runtime preserves legacy empty-string and invalid-value fallbacks', () => {
  const config = loadReviewRuntimeConfig({
    ORVEX_RATELIMIT_MAX_RETRIES: '',
    ORVEX_REVIEW_AGGREGATION_RUNS: '',
    ORVEX_VERIFY_CONCURRENCY: '',
    ORVEX_LLM_MAX_TOTAL_MS: '',
  });
  assert.equal(config.rateLimitMaxRetries, 2);
  assert.equal(config.aggregationRuns, 1);
  assert.equal(config.verifyConcurrency, 1);
  assert.equal(config.llmMaxTotalMs, 30_000);
});

test("large-PR intake reaches GitHub's file boundary without exceeding it", () => {
  const config = loadReviewRuntimeConfig({ MAX_FILE_BYTES: '5000000', MAX_FILES: '99999' });
  assert.equal(config.reviewInput.maxFileBytes, 5_000_000);
  assert.equal(config.reviewInput.maxFiles, 3_000);
});

test('GitHub and rules runtime loaders preserve secure defaults', () => {
  const github = loadGitHubRuntimeConfig({});
  assert.equal(github.webhookSecret, '');
  assert.equal(github.botLogin, 'orvex-review[bot]');
  assert.equal(github.allowUnsignedWebhooks, false);
  assert.equal(
    loadGitHubRuntimeConfig({ ORVEX_ALLOW_UNSIGNED_WEBHOOKS: '1' }).allowUnsignedWebhooks,
    true,
  );
  assert.throws(
    () => loadGitHubRuntimeConfig({ NODE_ENV: 'production', ORVEX_ALLOW_UNSIGNED_WEBHOOKS: '1' }),
    /only permitted outside production/,
  );
  assert.equal(loadRulesRuntimeConfig({}).semgrepDisabled, false);
  assert.equal(loadRulesRuntimeConfig({ SEMGREP_DISABLED: '1' }).semgrepDisabled, true);
});
