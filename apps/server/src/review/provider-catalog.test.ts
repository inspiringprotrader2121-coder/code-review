import assert from 'node:assert/strict';
import test from 'node:test';
import { createProviderCatalog } from './provider-catalog.js';
import {
  DEEPSEEK_REVIEW_OUTPUT_TOKENS,
  MINIMAX_REVIEW_OUTPUT_TOKENS,
  maxOutputTokensForModel,
} from './model-routing.js';
import type { WorkerConfig } from './worker-types.js';

function config(): WorkerConfig {
  return {
    standardModel: {
      apiKey: 'minimax-key',
      baseUrl: 'https://api.minimax.io/anthropic',
      model: 'MiniMax-M3',
      api: 'anthropic',
      transport: 'anthropic',
      admissionBucket: 'minimax',
      thinking: true,
      maxTokens: MINIMAX_REVIEW_OUTPUT_TOKENS,
    },
    codexCliModel: {
      apiKey: '',
      model: 'gpt-5.6-luna',
      transport: 'codex-cli',
      admissionBucket: 'luna',
      thinking: true,
      reasoningEffort: 'max',
    },
    deepseekFlashModel: {
      apiKey: 'deepseek-key',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
      api: 'responses',
      transport: 'responses',
      admissionBucket: 'deepseek',
      thinking: true,
      reasoningEffort: 'max',
      maxTokens: DEEPSEEK_REVIEW_OUTPUT_TOKENS,
    },
    openaiModel: null,
    deepseekModel: null,
  } as WorkerConfig;
}

test('catalog compiles exact public-plan targets without URL or api inference', () => {
  const catalog = createProviderCatalog(config());
  const high = catalog.compilePublicPlan('multi-model', { agenticLuna: true });
  assert.ok(high);
  assert.deepEqual(
    high.discovery.map((stage) => [
      stage.target.model,
      stage.target.transport,
      stage.target.reasoningEffort,
      stage.target.admissionBucket,
      stage.target.thinking,
    ]),
    [
      ['gpt-5.6-luna', 'codex-cli', 'max', 'luna', true],
      ['deepseek-v4-flash', 'responses', 'max', 'deepseek', true],
      ['MiniMax-M3', 'anthropic', undefined, 'minimax', true],
    ],
  );
  assert.equal(high.discovery[0]?.mode, 'agentic');
  assert.equal(high.discovery[1]?.mode, 'investigate');
  assert.equal(high.discovery[2]?.mode, 'api');
  assert.equal(high.verification.target.model, 'deepseek-v4-flash');
  assert.equal(high.verification.mode, 'api');
  assert.equal(high.verification.target.transport, 'responses');
  assert.equal(high.discovery.filter((stage) => stage.required).length, 3);
  assert.equal(high.verification.required, true);

  const lower = catalog.compilePublicPlan('dual-model', { agenticLuna: false });
  assert.ok(lower);
  assert.deepEqual(
    lower.discovery.map((stage) => [stage.target.model, stage.mode]),
    [
      ['MiniMax-M3', 'api'],
      ['deepseek-v4-flash', 'api'],
    ],
  );
  assert.equal(lower.verification.target.model, 'deepseek-v4-flash');
});

test('catalog is the only public-plan router', () => {
  const catalog = createProviderCatalog(config());
  assert.equal(
    catalog.resolvePublicDiscoveryStage('multi-model', 0, { agenticLuna: true })?.target.model,
    'gpt-5.6-luna',
  );
  assert.equal(
    catalog.resolvePublicDiscoveryStage('multi-model', 3, { agenticLuna: true })?.target.model,
    'MiniMax-M3',
  );
  assert.equal(
    catalog.resolvePublicDiscoveryStage('dual-model', 1, { agenticLuna: false })?.target.model,
    'deepseek-v4-flash',
  );
  assert.throws(
    () => catalog.resolvePublicDiscoveryStage('multi-model', 99, { agenticLuna: true }),
    /no discovery stage/,
  );
});

test('catalog refuses substitutions and incomplete reasoning contracts before a provider call', () => {
  const workerConfig = config();
  assert.throws(
    () =>
      createProviderCatalog({ ...workerConfig, codexCliModel: null }).compilePublicPlan(
        'multi-model',
        { agenticLuna: true },
      ),
    /pinned Codex CLI/,
  );
  assert.throws(
    () =>
      createProviderCatalog({
        ...workerConfig,
        deepseekFlashModel: { ...workerConfig.deepseekFlashModel!, transport: 'compatible-chat' },
      }).compilePublicPlan('dual-model', { agenticLuna: false }),
    /DeepSeek v4 Flash at max reasoning/,
  );
  assert.throws(
    () =>
      createProviderCatalog({
        ...workerConfig,
        deepseekFlashModel: { ...workerConfig.deepseekFlashModel!, api: 'chat' },
      }).compilePublicPlan('dual-model', { agenticLuna: false }),
    /DeepSeek v4 Flash at max reasoning/,
  );
  assert.throws(
    () =>
      createProviderCatalog({
        ...workerConfig,
        deepseekFlashModel: { ...workerConfig.deepseekFlashModel!, maxTokens: 64_000 },
      }).compilePublicPlan('dual-model', { agenticLuna: false }),
    /DeepSeek v4 Flash at max reasoning/,
  );
  assert.throws(
    () =>
      createProviderCatalog({
        ...workerConfig,
        standardModel: { ...workerConfig.standardModel, thinking: false },
      }).compilePublicPlan('dual-model', { agenticLuna: false }),
    /MiniMax thinking/,
  );
  assert.throws(
    () =>
      createProviderCatalog({
        ...workerConfig,
        standardModel: { ...workerConfig.standardModel, maxTokens: 48_000 },
      }).compilePublicPlan('dual-model', { agenticLuna: false }),
    /MiniMax thinking/,
  );
});

test('MiniMax has room for reasoning and a completed review response', () => {
  assert.equal(MINIMAX_REVIEW_OUTPUT_TOKENS, 128_000);
  assert.equal(maxOutputTokensForModel('MiniMax-M3'), 128_000);
});
