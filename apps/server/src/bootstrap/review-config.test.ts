import assert from 'node:assert/strict';
import test from 'node:test';
import type { AppDatabase } from '@orvex-review/store';
import { createProviderCatalog } from '../review/provider-catalog.js';
import { createWorkerConfig } from './review-config.js';
import { loadServerConfig } from './config.js';

const fixedEnvironment = Object.freeze({
  GITHUB_APP_ID: '123',
  GITHUB_APP_PRIVATE_KEY: 'test-private-key',
  MINIMAX_API_KEY: 'minimax-test-key',
  MINIMAX_API: 'anthropic',
  MINIMAX_MODEL: 'MiniMax-M3',
  ORVEX_DEEPSEEK_API_KEY: 'deepseek-test-key',
  ORVEX_DEEPSEEK_MODEL: 'deepseek-v4-pro',
  ORVEX_DEEPSEEK_FLASH_MODEL: 'deepseek-v4-flash',
  ORVEX_CODEX_CLI: '1',
  ORVEX_CODEX_CLI_REPOS: 'acme/widgets',
  ORVEX_OPENAI_API_KEY: 'openai-test-key',
  ORVEX_OPENAI_REASONING_EFFORT: 'max',
  ORVEX_REVIEW_COOLDOWN_S: '42',
  ORVEX_REVIEW_MAX_CALLS: '31',
  ORVEX_MAX_UNANCHORED_COMMENTS: '7',
} satisfies NodeJS.ProcessEnv);

test('one immutable bootstrap snapshot compiles both public plan contracts exactly', () => {
  const server = loadServerConfig(fixedEnvironment);
  const worker = createWorkerConfig(server, {} as AppDatabase);
  const catalog = createProviderCatalog(worker);

  const high = catalog.compilePublicPlan('multi-model', { agenticLuna: true });
  assert.ok(high);
  assert.deepEqual(
    [...high.discovery, high.verification].map((stage) => [
      stage.target.model,
      stage.target.transport,
      stage.target.reasoningEffort,
    ]),
    [
      ['gpt-5.6-luna', 'codex-cli', 'max'],
      ['deepseek-v4-flash', 'compatible-chat', 'max'],
      ['deepseek-v4-flash', 'compatible-chat', 'max'],
      ['MiniMax-M3', 'anthropic', undefined],
      ['deepseek-v4-flash', 'compatible-chat', 'max'],
    ],
  );

  const lower = catalog.compilePublicPlan('dual-model', { agenticLuna: false });
  assert.ok(lower);
  assert.deepEqual(
    [...lower.discovery, lower.verification].map((stage) => stage.target.model),
    ['MiniMax-M3', 'deepseek-v4-flash', 'deepseek-v4-flash'],
  );
  assert.equal(worker.reviewRuntime?.cooldownSeconds, 42);
  assert.equal(worker.reviewRuntime?.execution.maxCalls, 31);
  assert.equal(worker.reviewRuntime?.verifyConcurrency, 3);
  assert.equal(worker.reviewRuntime?.publication.maxUnanchoredComments, 7);
  assert.ok(Object.isFrozen(server.review));
  assert.ok(Object.isFrozen(worker.reviewRuntime));
});

test('provider targets and policies do not observe environment changes after bootstrap', () => {
  const server = loadServerConfig(fixedEnvironment);
  const worker = createWorkerConfig(server, {} as AppDatabase);
  const before = createProviderCatalog(worker).compilePublicPlan('multi-model', {
    agenticLuna: true,
  });
  assert.ok(before);

  const originalFlash = process.env.ORVEX_DEEPSEEK_FLASH_MODEL;
  const originalRepos = process.env.ORVEX_CODEX_CLI_REPOS;
  process.env.ORVEX_DEEPSEEK_FLASH_MODEL = 'unapproved-substitute';
  process.env.ORVEX_CODEX_CLI_REPOS = 'other/repository';
  try {
    const after = createProviderCatalog(worker).compilePublicPlan('multi-model', {
      agenticLuna: true,
    });
    assert.ok(after);
    assert.deepEqual(
      after.discovery.map((stage) => stage.target.model),
      before.discovery.map((stage) => stage.target.model),
    );
    assert.equal(worker.reviewRuntime?.routingPolicy.codexRepoAllowed('acme/widgets'), true);
    assert.equal(worker.reviewRuntime?.routingPolicy.codexRepoAllowed('other/repository'), false);
  } finally {
    if (originalFlash === undefined) delete process.env.ORVEX_DEEPSEEK_FLASH_MODEL;
    else process.env.ORVEX_DEEPSEEK_FLASH_MODEL = originalFlash;
    if (originalRepos === undefined) delete process.env.ORVEX_CODEX_CLI_REPOS;
    else process.env.ORVEX_CODEX_CLI_REPOS = originalRepos;
  }
});
