import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canRunAgentic, effectiveReviewConfig, modelForPass, type WorkerConfig } from './pipeline.js';
import { isHedgedRejection } from '@orvex-review/review';

function modelRoutingConfig(): WorkerConfig {
  return {
    standardModel: {
      apiKey: 'standard-key',
      baseUrl: 'https://api.minimax.io/anthropic',
      model: 'MiniMax-M3',
      api: 'anthropic',
    },
    openaiModel: {
      apiKey: 'openai-key',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5.6-luna',
      api: 'responses',
      reasoningEffort: 'xhigh',
    },
  } as WorkerConfig;
}

test('workspace review defaults apply unless config-as-code overrides them', () => {
  const workspace = { defaultReviewMode: 'strict' as const, minConfidence: 0.6, maxComments: 8 };
  const fromDashboard = effectiveReviewConfig(null, workspace);
  assert.equal(fromDashboard.mode, 'strict');
  assert.equal(fromDashboard.min_confidence, 0.6);
  assert.equal(fromDashboard.max_comments, 8);

  const perRepoMode = effectiveReviewConfig(null, workspace, 'normal');
  assert.equal(perRepoMode.mode, 'normal');

  const fromFile = effectiveReviewConfig('mode: normal\nmin_confidence: 0.75\nmax_comments: 12', workspace, 'strict');
  assert.equal(fromFile.mode, 'normal');
  assert.equal(fromFile.min_confidence, 0.75);
  assert.equal(fromFile.max_comments, 12);
});

test('hedged / low-information rejections are rescued', () => {
  const hedged = [
    'cannot verify this from the code shown',
    'Cannot independently confirm the claim',
    'insufficient context to validate',
    'not enough evidence in the diff',
    'unclear whether this path is reachable',
    'the invariant is validated elsewhere',
    'handled elsewhere, presumably safe',
    'this seems fine',
    'appears intentional',
    'unable to determine from the provided source',
    'could not find evidence of a bug',
  ];
  for (const reason of hedged) {
    assert.equal(isHedgedRejection(reason), true, `expected hedged: ${reason}`);
  }
});

test('factual refutations stand (drop is NOT rescued)', () => {
  const factual = [
    'parseConfig() already rejects NaN at line 42, so the claimed crash cannot occur',
    'the function returns early when user is null; the NPE the finding describes is impossible',
    'claim is wrong: the migration adds a NOT NULL constraint before the backfill',
    'the endpoint requires auth via requireSession middleware, the finding is incorrect',
    'redis.ts uses WATCH/MULTI here, making the described race impossible',
  ];
  for (const reason of factual) {
    assert.equal(isHedgedRejection(reason), false, `expected factual: ${reason}`);
  }
});

test('Verify routes its first pass to the direct OpenAI Luna target', () => {
  const config = modelRoutingConfig();

  const firstPass = modelForPass(config, { modelTier: 'multi-model' }, 0);
  assert.equal(firstPass.tier, 'openai');
  assert.equal(firstPass.target.model, 'gpt-5.6-luna');
  assert.equal(firstPass.target.api, 'responses');

  const thirdPass = modelForPass(config, { modelTier: 'multi-model' }, 2);
  assert.equal(thirdPass.tier, 'standard');
  assert.equal(thirdPass.target.model, 'MiniMax-M3');
  assert.equal(thirdPass.target.api, 'anthropic');
});

test('canRunAgentic: all three conditions are load-bearing', (t) => {
  const prev = { flag: process.env.ORVEX_CODEX_CLI, repos: process.env.ORVEX_CODEX_CLI_REPOS };
  t.after(() => {
    if (prev.flag === undefined) delete process.env.ORVEX_CODEX_CLI;
    else process.env.ORVEX_CODEX_CLI = prev.flag;
    if (prev.repos === undefined) delete process.env.ORVEX_CODEX_CLI_REPOS;
    else process.env.ORVEX_CODEX_CLI_REPOS = prev.repos;
  });

  process.env.ORVEX_CODEX_CLI = '1';
  process.env.ORVEX_CODEX_CLI_REPOS = 'acme/api';
  assert.equal(canRunAgentic({ modelTier: 'multi-model' }, 'acme/api'), true);
  assert.equal(canRunAgentic({ modelTier: 'multi-model' }, 'ACME/API'), true, 'allowlist is case-insensitive');

  // 3. repo NOT allowlisted — codex runs an unsandboxed shell, so this is a
  //    security boundary. A third-party tenant must never reach it on plan alone.
  assert.equal(canRunAgentic({ modelTier: 'multi-model' }, 'evil/repo'), false);
  // 2. wrong tier
  assert.equal(canRunAgentic({ modelTier: 'standard' }, 'acme/api'), false);
  // 1. flag off
  process.env.ORVEX_CODEX_CLI = '0';
  assert.equal(canRunAgentic({ modelTier: 'multi-model' }, 'acme/api'), false);
  // fail-closed when the allowlist is unset entirely
  process.env.ORVEX_CODEX_CLI = '1';
  delete process.env.ORVEX_CODEX_CLI_REPOS;
  assert.equal(canRunAgentic({ modelTier: 'multi-model' }, 'acme/api'), false, 'unset allowlist = never');
});

test('modelForPass never hands back the CLI stub when codex cannot run', () => {
  // The stub has apiKey:'' and no baseUrl — on the plain HTTP path it resolves
  // to the Anthropic client and 401s. Pass 1 is required, so that aborted every
  // review on the affected tiers.
  const config = {
    codexCliModel: { apiKey: '', model: 'gpt-5.6-luna' },
    openaiModel: { apiKey: 'k', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.6-luna' },
    standardModel: { apiKey: 's', baseUrl: 'https://x/v1', model: 'MiniMax-M3' },
    deepseekModel: null,
  } as unknown as WorkerConfig;

  const notAgentic = modelForPass(config, { modelTier: 'multi-model' }, 0, false);
  assert.equal(notAgentic.target.apiKey, 'k', 'falls through to the real API target');
  assert.equal(modelForPass(config, { modelTier: 'multi-model' }, 0).target.apiKey, 'k', 'defaults to non-agentic');

  const agentic = modelForPass(config, { modelTier: 'multi-model' }, 0, true);
  assert.equal(agentic.target.apiKey, '', 'the CLI stub is only selected when codex will actually run');
});
