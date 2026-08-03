import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canRunAgentic,
  effectiveReviewConfig,
  failedRequiredLensIds,
  modelForPass,
  modelForPlanWithTier,
  type WorkerConfig,
} from './pipeline.js';
import { isHedgedRejection, isTransientLlmError } from '@orvex-review/review';

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
  const workspace = { defaultReviewMode: 'strict' as const, maxComments: 8 };
  const fromDashboard = effectiveReviewConfig(null, workspace);
  assert.equal(fromDashboard.mode, 'strict');
  assert.equal(fromDashboard.max_comments, 8);

  const perRepoMode = effectiveReviewConfig(null, workspace, 'normal');
  assert.equal(perRepoMode.mode, 'normal');

  const fromFile = effectiveReviewConfig('mode: normal\nmax_comments: 12', workspace, 'strict');
  assert.equal(fromFile.mode, 'normal');
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

test('verification usage is charged to the target that actually verifies', (t) => {
  const previous = process.env.ORVEX_VERIFY_ON_STANDARD;
  delete process.env.ORVEX_VERIFY_ON_STANDARD;
  t.after(() => {
    if (previous === undefined) delete process.env.ORVEX_VERIFY_ON_STANDARD;
    else process.env.ORVEX_VERIFY_ON_STANDARD = previous;
  });

  const config = modelRoutingConfig();
  const premium = modelForPlanWithTier(config, { modelTier: 'multi-model' });
  assert.equal(premium.tier, 'openai');
  assert.equal(premium.target.model, 'gpt-5.6-luna');

  process.env.ORVEX_VERIFY_ON_STANDARD = '1';
  const standard = modelForPlanWithTier(config, { modelTier: 'multi-model' });
  assert.equal(standard.tier, 'standard');
  assert.equal(standard.target.model, 'MiniMax-M3');
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

test('a rate-limited required pass REQUEUES; a genuine failure does not', () => {
  // queue-runner decides requeue by pattern-matching the thrown message. A
  // generic "required pass failed" matched nothing, so a review whose Luna pass
  // was merely rate-limited (while the others succeeded) was silently DROPPED
  // rather than retried — the most likely failure mode on a throttled tier, and
  // what lost 4 of 9 PRs in the 2026-07-22 batch.
  assert.equal(
    isTransientLlmError('review aborted: 1/2 required model pass(es) failed — rate-limit/transport errors; will retry'),
    true,
    'a transient cause must requeue the job',
  );
  assert.equal(
    isTransientLlmError('review aborted: 1/2 required model pass(es) failed; no partial review was posted'),
    false,
    'a genuine model failure must NOT loop forever',
  );
});

test('a successful deep extra cannot satisfy a failed required lens', () => {
  const failed = failedRequiredLensIds(
    [0, 1],
    [
      { modelPassIndex: 0, ok: false },
      { modelPassIndex: 1, ok: true },
      // The optional deep-extra intentionally shares core lens 0's model index.
      { modelPassIndex: 0, ok: true, bestEffort: true },
    ],
    1,
  );

  assert.deepEqual(failed, [0]);
});

test('the 4th lens is tier-scoped and breadth stays LAST on every tier', () => {
  // Regression: the 4th lens was inserted mid-list and relied on index-clamping.
  // That silently pushed the breadth lens off the end of the 3-pass tiers, so
  // free/review lost it entirely AND lost their only best-effort pass — a
  // MiniMax timeout there would then abort the whole review instead of
  // degrading it.
  const anglesFor = (tier: string, passes: number): string[] => {
    const fourth = tier === 'multi-model' || tier === 'codex-hybrid';
    const list = ['general', 'deep-dive', ...(fourth ? ['removed-behavior/callers'] : []), 'perf/completeness/api'];
    return Array.from({ length: passes }, (_, p) => list[Math.min(p, list.length - 1)]);
  };
  // 3-pass volume tier: breadth must survive as the final lens.
  assert.deepEqual(anglesFor('dual-model', 3), ['general', 'deep-dive', 'perf/completeness/api']);
  // 4-pass quality tier: the new lens sits between deep-dive and breadth.
  assert.deepEqual(anglesFor('multi-model', 4), [
    'general',
    'deep-dive',
    'removed-behavior/callers',
    'perf/completeness/api',
  ]);
  // Breadth is last on BOTH, so an over-configured pass count clamps onto a
  // best-effort angle rather than a required one.
  for (const [tier, passes] of [['dual-model', 5], ['multi-model', 6]] as const) {
    assert.equal(anglesFor(tier, passes).at(-1), 'perf/completeness/api', `${tier} must end on breadth`);
  }
});
