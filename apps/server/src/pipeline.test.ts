import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effectiveReviewConfig, modelForPass, type WorkerConfig } from './pipeline.js';
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
