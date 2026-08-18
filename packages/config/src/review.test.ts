import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import {
  loadGitHubRuntimeConfig,
  loadReviewRuntimeConfig,
  loadRulesRuntimeConfig,
} from './index.js';

const require = createRequire(import.meta.url);

test('review runtime defaults preserve production safety limits', () => {
  const config = loadReviewRuntimeConfig({});
  assert.equal(config.openAiReasoningEffort, 'high');
  assert.equal(config.llmTimeoutMs, 240_000);
  assert.equal(config.llmMaxTotalMs, 480_000);
  assert.equal(config.maxOutputTokens, 128_000);
  assert.equal(config.maxOutputTokensCap, 128_000);
  assert.equal(config.codexTimeoutMs, 480_000);
  assert.equal(config.codexInactivityTimeoutMs, 300_000);
  assert.equal(config.maxFindings, 25);
  assert.equal(config.reviewWorkerConcurrency, 8);
  assert.equal(config.execution.concurrency, 8);
  assert.equal(config.codexApiKeyConcurrency, 8);
  assert.equal(config.providerConcurrency('luna'), 8);
  assert.equal(config.providerConcurrency('deepseek'), 8);
  assert.equal(config.fleetProviderConcurrency('luna'), 8);
  assert.equal(config.fleetProviderCapacityEpoch, 'v1');
  assert.equal(config.fleetTenantConcurrency, 8);
  assert.equal(config.deepseekTpmPerAccount, 2_000_000);
  assert.equal(config.deepseekTpmWindowMs, 60_000);
  assert.equal(config.deepseekTpmReserveOutput, 70_000);
  assert.equal(config.lunaTpmPerAccount, 2_000_000);
  assert.equal(config.lunaTpmWindowMs, 60_000);
  assert.equal(config.lunaTpmReserveOutput, 128_000);
  assert.equal(config.promptChangedChars, 16_000);
  assert.equal(config.promptRelatedChars, 6_000);
  assert.equal(config.promptOtherChars, 2_000);
  assert.equal(config.reviewInput.maxFileBytes, 1_000_000);
  assert.equal(config.reviewInput.maxFiles, 3_000);
  assert.deepEqual(config.codexAllowedRepos, []);
  assert.ok(Object.isFrozen(config));
  assert.ok(Object.isFrozen(config.childProcessEnvironment));
});

test('pinned DeepSeek pricing cannot inherit stale env rates', () => {
  const config = loadReviewRuntimeConfig({
    ORVEX_DEEPSEEK_COST_INPUT_PER_M: '0.435',
    ORVEX_DEEPSEEK_CACHED_INPUT_COST_PER_M: '0.003625',
    ORVEX_DEEPSEEK_COST_OUTPUT_PER_M: '0.87',
    ORVEX_DEEPSEEK_FLASH_COST_INPUT_PER_M: '0.14',
    ORVEX_DEEPSEEK_FLASH_CACHED_INPUT_COST_PER_M: '0.0028',
    ORVEX_DEEPSEEK_FLASH_COST_OUTPUT_PER_M: '0.28',
  });

  assert.deepEqual(config.pricing.deepseek, { input: 0.66, cachedInput: 0.022, output: 1.98 });
  assert.deepEqual(config.pricing.deepseekFlash, {
    input: 0.22,
    cachedInput: 0.007,
    output: 0.66,
  });
  assert.deepEqual(config.pricing.modelRates['deepseek-v4-pro'], {
    input: 0.66,
    cachedInput: 0.022,
    output: 1.98,
  });
  assert.deepEqual(config.pricing.modelRates['deepseek-v4-flash'], {
    input: 0.22,
    cachedInput: 0.007,
    output: 0.66,
  });
});

test('pinned Luna pricing cannot inherit stale generic OpenAI rates', () => {
  const config = loadReviewRuntimeConfig({
    ORVEX_OPENAI_COST_INPUT_PER_M: '0.2',
    ORVEX_OPENAI_CACHED_INPUT_COST_PER_M: '0.02',
    ORVEX_OPENAI_COST_OUTPUT_PER_M: '1.2',
    ORVEX_LUNA_COST_INPUT_PER_M: '0.2',
    ORVEX_LUNA_CACHED_INPUT_COST_PER_M: '0.02',
    ORVEX_LUNA_COST_OUTPUT_PER_M: '1.2',
  });

  assert.deepEqual(config.pricing.openai, { input: 0.2, cachedInput: 0.02, output: 1.2 });
  assert.deepEqual(config.pricing.modelRates['gpt-5.6-luna'], {
    input: 1,
    cachedInput: 0.1,
    output: 6,
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
  assert.equal(config.fleetProviderConcurrency('luna'), 7);
  assert.deepEqual(config.codexAllowedRepos, ['acme/widgets', 'acme/api']);
  assert.deepEqual(config.childProcessEnvironment, { PATH: '/usr/bin' });
});

test('review-stage concurrency remains an explicit bounded operator override', () => {
  const config = loadReviewRuntimeConfig({
    ORVEX_CODEX_CLI: '1',
    ORVEX_MAX_CONCURRENT_REVIEWS: '8',
    ORVEX_CODEX_APIKEY_CONCURRENCY: '8',
    ORVEX_PROVIDER_CONCURRENCY_LUNA: '8',
    ORVEX_PROVIDER_CONCURRENCY_DEEPSEEK: '8',
    ORVEX_PROVIDER_CONCURRENCY_MINIMAX: '8',
    ORVEX_VERIFY_CONCURRENCY: '1',
    ORVEX_REVIEW_CONCURRENCY: '3',
  });

  assert.equal(config.reviewWorkerConcurrency, 8);
  assert.equal(config.codexApiKeyConcurrency, 8);
  assert.equal(config.providerConcurrency('luna'), 8);
  assert.equal(config.providerConcurrency('deepseek'), 8);
  assert.equal(config.providerConcurrency('minimax'), 8);
  assert.equal(config.fleetProviderConcurrency('minimax'), 8);
  assert.equal(config.verifyConcurrency, 1);
  assert.equal(config.execution.concurrency, 3);
});

test('one eight-review worker can admit every independent API chunk concurrently', () => {
  const config = loadReviewRuntimeConfig({
    ORVEX_CODEX_CLI: '1',
    ORVEX_MAX_CONCURRENT_REVIEWS: '8',
    ORVEX_CODEX_APIKEY_CONCURRENCY: '8',
    ORVEX_PROVIDER_CONCURRENCY_LUNA: '8',
    ORVEX_PROVIDER_CONCURRENCY_DEEPSEEK: '64',
    ORVEX_PROVIDER_CONCURRENCY_MINIMAX: '32',
    ORVEX_REVIEW_CONCURRENCY: '8',
  });

  assert.equal(config.providerConcurrency('luna'), 8);
  assert.equal(config.providerConcurrency('deepseek'), 64);
  assert.equal(config.providerConcurrency('minimax'), 32);
  assert.equal(config.execution.concurrency, 8);
});

test('local provider concurrency keeps provider-specific safety bounds', () => {
  const config = loadReviewRuntimeConfig({
    ORVEX_PROVIDER_CONCURRENCY_LUNA: '999',
    ORVEX_PROVIDER_CONCURRENCY_DEEPSEEK: '999',
    ORVEX_PROVIDER_CONCURRENCY_MINIMAX: '999',
  });

  assert.equal(config.providerConcurrency('luna'), 999);
  assert.equal(config.providerConcurrency('deepseek'), 999);
  assert.equal(config.providerConcurrency('minimax'), 999);
});

test('fleet provider capacity is independent from per-worker capacity and snapshots its environment', () => {
  const env: NodeJS.ProcessEnv = {
    ORVEX_MAX_CONCURRENT_REVIEWS: '4',
    ORVEX_PROVIDER_CONCURRENCY_LUNA: '3',
    ORVEX_FLEET_PROVIDER_CONCURRENCY_LUNA: '64',
    ORVEX_FLEET_TENANT_CONCURRENCY: '12',
    ORVEX_FLEET_CAPACITY_EPOCH: 'fleet-2026-08',
  };
  const config = loadReviewRuntimeConfig(env);
  assert.equal(config.providerConcurrency('luna'), 3);
  assert.equal(config.fleetProviderConcurrency('luna'), 64);
  assert.equal(config.fleetProviderConcurrency('deepseek'), 4);
  assert.equal(config.fleetProviderCapacityEpoch, 'fleet-2026-08');
  assert.equal(config.fleetTenantConcurrency, 12);

  env.ORVEX_PROVIDER_CONCURRENCY_LUNA = '20';
  env.ORVEX_FLEET_PROVIDER_CONCURRENCY_LUNA = '200';
  assert.equal(config.providerConcurrency('luna'), 3);
  assert.equal(config.fleetProviderConcurrency('luna'), 64);
  assert.throws(
    () => loadReviewRuntimeConfig({ ORVEX_FLEET_CAPACITY_EPOCH: 'unsafe epoch' }),
    /ORVEX_FLEET_CAPACITY_EPOCH/,
  );
});

test('production PM2 profile splits api/scheduler/workers with fleet Redis caps', () => {
  const ecosystem = readFileSync(new URL('../../../ecosystem.config.cjs', import.meta.url), 'utf8');
  const config = require('../../../ecosystem.config.cjs') as {
    apps: Array<{ name: string; args: string; kill_timeout?: number }>;
  };
  const names = config.apps.map((app) => app.name);
  assert.ok(names.includes('velatrix-api'));
  assert.ok(names.includes('velatrix-scheduler'));
  assert.equal(names.filter((name) => name.startsWith('velatrix-worker-')).length, 13);
  assert.match(ecosystem, /deploy-safe/);
  const apiArgs = config.apps.find((app) => app.name === 'velatrix-api')?.args ?? '';
  const schedulerArgs = config.apps.find((app) => app.name === 'velatrix-scheduler')?.args ?? '';
  const workerArgs = config.apps.find((app) => app.name === 'velatrix-worker-01')?.args ?? '';
  assert.match(apiArgs, /ORVEX_PROCESS_ROLE=api/);
  assert.match(schedulerArgs, /ORVEX_PROCESS_ROLE=scheduler/);
  assert.match(schedulerArgs, /ORVEX_WORKER_ID=scheduler-01/);
  assert.match(workerArgs, /ORVEX_PROCESS_ROLE=worker/);
  assert.match(workerArgs, /ORVEX_WORKER_ID=review-worker-01/);
  assert.match(workerArgs, /ORVEX_MAX_CONCURRENT_REVIEWS=10000(?:\s|\\")/);
  assert.match(workerArgs, /ORVEX_PROVIDER_CONCURRENCY_LUNA=10000(?:\s|\\")/);
  assert.match(workerArgs, /ORVEX_PROVIDER_CONCURRENCY_DEEPSEEK=10000(?:\s|\\")/);
  assert.match(workerArgs, /ORVEX_PROVIDER_CONCURRENCY_MINIMAX=10000(?:\s|\\")/);
  assert.match(workerArgs, /ORVEX_FLEET_PROVIDER_CONCURRENCY_LUNA=10000(?:\s|\\")/);
  assert.match(workerArgs, /ORVEX_FLEET_PROVIDER_CONCURRENCY_DEEPSEEK=10000(?:\s|\\")/);
  assert.match(workerArgs, /ORVEX_FLEET_PROVIDER_CONCURRENCY_MINIMAX=10000(?:\s|\\")/);
  assert.match(workerArgs, /ORVEX_FLEET_TENANT_CONCURRENCY=8(?:\s|\\")/);
  assert.match(workerArgs, /ORVEX_UNLIMITED_GITHUB_OWNERS=inspiringprotrader2121-coder(?:\s|\\")/);
  assert.match(
    workerArgs,
    /ORVEX_UNLIMITED_ACCOUNT_EMAILS=inspiringprotrader2121@gmail.com(?:\s|\\")/,
  );
  assert.match(
    workerArgs,
    /ORVEX_UNLIMITED_TENANT_SLUGS=org-inspiringprotrader2121-coder,inspiringprotrader2121-coder(?:\s|\\")/,
  );
  assert.match(workerArgs, /ORVEX_PROVIDER_LEASE_WAIT_MS=600000(?:\s|\\")/);
  assert.match(workerArgs, /ORVEX_FLEET_CAPACITY_EPOCH=review-scale-v4(?:\s|\\")/);
  assert.match(workerArgs, /ORVEX_REVIEW_CONCURRENCY=10000(?:\s|\\")/);
  assert.match(workerArgs, /ORVEX_VERIFY_CONCURRENCY=10000(?:\s|\\")/);
  assert.match(workerArgs, /ORVEX_MAX_SANDBOXES=10000(?:\s|\\")/);
  assert.match(workerArgs, /ORVEX_SHUTDOWN_DRAIN_MS=960000(?:\s|\\")/);
  assert.match(workerArgs, /ORVEX_LEASE_RENEW_MS=60000(?:\s|\\")/);
  assert.match(workerArgs, /ORVEX_MONTHLY_COGS_CAP_USD=5000(?:\s|\\")/);
  assert.match(workerArgs, /ORVEX_MAX_OUTPUT_TOKENS=128000(?:\s|\\")/);
  assert.match(workerArgs, /ORVEX_MAX_OUTPUT_TOKENS_CAP=128000(?:\s|\\")/);
  assert.match(workerArgs, /ORVEX_HOST_MIN_AVAILABLE_MEMORY_BYTES=1073741824(?:\s|\\")/);
  assert.match(workerArgs, /ORVEX_HOST_MIN_AVAILABLE_DISK_BYTES=2147483648(?:\s|\\")/);
  assert.ok(config.apps.every((app) => app.kill_timeout === 1_020_000));
  assert.ok(
    workerArgs.indexOf('. ./.env') < workerArgs.indexOf('ORVEX_MAX_CONCURRENT_REVIEWS=10000'),
  );
  assert.ok(workerArgs.indexOf('. ./.env') < workerArgs.indexOf('ORVEX_MAX_OUTPUT_TOKENS=128000'));
  assert.ok(
    workerArgs.indexOf('. ./.env') <
      workerArgs.indexOf('ORVEX_HOST_MIN_AVAILABLE_MEMORY_BYTES=1073741824'),
  );
});

test('verify and sandbox concurrency honor the production scale ceilings', () => {
  const config = loadReviewRuntimeConfig({ ORVEX_VERIFY_CONCURRENCY: '32' });
  assert.equal(config.verifyConcurrency, 32);
  assert.equal(
    loadReviewRuntimeConfig({ ORVEX_VERIFY_CONCURRENCY: '99999' }).verifyConcurrency,
    10_000,
  );
  assert.equal(
    loadReviewRuntimeConfig({ ORVEX_MONTHLY_COGS_CAP_USD: '5000' }).accountLimits.monthlyCogsCapUsd,
    5_000,
  );
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

test('rate-limit wait defaults cover multi-minute TPM windows', () => {
  const defaults = loadReviewRuntimeConfig({});
  assert.equal(defaults.rateLimitMaxWaitMs, 120_000);
  assert.equal(defaults.rateLimitTotalWaitMs, 180_000);
  assert.equal(
    loadReviewRuntimeConfig({ ORVEX_RATELIMIT_TOTAL_WAIT_MS: '300000' }).rateLimitTotalWaitMs,
    300_000,
  );
  assert.equal(
    loadReviewRuntimeConfig({ ORVEX_LUNA_TPM_PER_ACCOUNT: '4000000' }).lunaTpmPerAccount,
    4_000_000,
  );
});

test('review runtime allows multi-minute LLM walls up to 15 minutes', () => {
  assert.equal(
    loadReviewRuntimeConfig({ ORVEX_LLM_MAX_TOTAL_MS: '600000' }).llmMaxTotalMs,
    600_000,
  );
  assert.equal(
    loadReviewRuntimeConfig({ ORVEX_LLM_MAX_TOTAL_MS: '9999999' }).llmMaxTotalMs,
    900_000,
  );
});

test("large-PR intake reaches GitHub's file boundary without exceeding it", () => {
  const config = loadReviewRuntimeConfig({ MAX_FILE_BYTES: '5000000', MAX_FILES: '99999' });
  assert.equal(config.reviewInput.maxFileBytes, 5_000_000);
  assert.equal(config.reviewInput.maxFiles, 3_000);
});

test('large-PR intake raises legacy prompt-era caps to the complete-coverage floor', () => {
  const config = loadReviewRuntimeConfig({ MAX_FILE_BYTES: '120000', MAX_FILES: '40' });
  assert.equal(config.reviewInput.maxFileBytes, 1_000_000);
  assert.equal(config.reviewInput.maxFiles, 3_000);
});

test('GitHub and rules runtime loaders preserve secure defaults', () => {
  const github = loadGitHubRuntimeConfig({});
  assert.equal(github.webhookSecret, '');
  assert.equal(github.botLogin, 'orvex-review[bot]');
  assert.equal(github.allowUnsignedWebhooks, false);
  assert.equal(github.paceTokensPerSecond, 8);
  assert.equal(github.paceBurst, 20);
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
