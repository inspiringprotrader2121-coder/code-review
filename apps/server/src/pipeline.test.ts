import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canRunAgentic,
  canRunInvestigate,
  canRunRiskHunt,
  accountUsage,
  buildReviewPassAngles,
  effectiveReviewConfig,
  failedRequiredLensIds,
  modelForInvestigate,
  modelForPass,
  modelForPlanWithTier,
  maxRiskProbes,
  modelForRiskHunt,
  providerConfigurationIssue,
  selectRiskProbes,
  usageProvider,
  type WorkerConfig,
} from './pipeline.js';
import { isHedgedRejection, isTransientLlmError } from '@orvex-review/review';
import { planFeatures } from '@orvex-review/tenants';

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
    deepseekModel: {
      apiKey: 'deepseek-key',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-pro',
      api: 'chat',
    },
    deepseekFlashModel: {
      apiKey: 'deepseek-flash-key',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
      api: 'chat',
    },
  } as WorkerConfig;
}

test('required paid model stacks fail closed when a provider is missing', () => {
  const config = modelRoutingConfig();
  assert.equal(providerConfigurationIssue(planFeatures('verify'), config), null);
  const missingFrontier = providerConfigurationIssue(planFeatures('verify'), {
    ...config,
    openaiModel: null,
    codexCliModel: null,
  });
  assert.ok(missingFrontier);
  assert.match(missingFrontier, /frontier review provider/);
  const missingIndependent = providerConfigurationIssue(planFeatures('review'), {
    ...config,
    deepseekModel: null,
    deepseekFlashModel: null,
  });
  assert.ok(missingIndependent);
  assert.match(missingIndependent, /independent review provider/);
});

test('usage accounting clamps malformed provider token counts instead of poisoning cost totals', () => {
  const accounted = accountUsage(
    'standard',
    modelRoutingConfig().standardModel,
    'discovery',
    { inputTokens: Number.NaN, outputTokens: -10, tokenSource: 'provider' },
  );
  assert.equal(accounted.inputTokens, 0);
  assert.equal(accounted.outputTokens, 0);
  assert.equal(accounted.costUsd, 0);
});

test('usage attribution labels the default no-base-url client as Anthropic', () => {
  assert.equal(
    usageProvider({ apiKey: 'key', model: 'claude-sonnet', api: undefined }, 'review'),
    'anthropic',
  );
});

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

test('the explicit-behavior rejection bullet produces reasons that survive as factual', () => {
  // The strict prompt's "explicitly surfaces it" bullet only works if the
  // rejection wording it elicits is NOT then classified as a hedge and rescued.
  // The canonical phrasings must stay factual; the known collisions must stay
  // hedged (they lean on "elsewhere"/"intentional" vocabulary, which IS hedging
  // when the evidence is not quoted inline).
  const factual = [
    'the function explicitly returns a skipped reason at line 371, so the omission is not silent',
    'not silent: consumePlatformToken() returns { skipped: "legacy" } to its caller at token.js:176',
    'the error is propagated to the caller via reject() at line 88, contradicting the swallowed claim',
  ];
  for (const reason of factual) {
    assert.equal(isHedgedRejection(reason), false, `expected factual: ${reason}`);
  }
  const stillHedged = [
    'not silent: the condition is logged and handled elsewhere by reportSkip() at util.ts:20',
    'the fallback appears intentional; line 42 says fall back to HTTP by design',
  ];
  for (const reason of stillHedged) {
    assert.equal(isHedgedRejection(reason), true, `expected hedged: ${reason}`);
  }
});

test('Verify routes its first pass to the direct OpenAI Luna target', () => {
  const config = modelRoutingConfig();

  const firstPass = modelForPass(config, { modelTier: 'multi-model' }, 0);
  assert.equal(firstPass.tier, 'openai');
  assert.equal(firstPass.target.model, 'gpt-5.6-luna');
  assert.equal(firstPass.target.api, 'responses');

  const secondPass = modelForPass(config, { modelTier: 'multi-model' }, 1);
  assert.equal(secondPass.tier, 'deepseek-flash');
  assert.equal(secondPass.target.model, 'deepseek-v4-flash');

  const thirdPass = modelForPass(config, { modelTier: 'multi-model' }, 2);
  assert.equal(thirdPass.tier, 'deepseek-flash');
  assert.equal(thirdPass.target.model, 'deepseek-v4-flash');

  const fourthPass = modelForPass(config, { modelTier: 'multi-model' }, 3);
  assert.equal(fourthPass.tier, 'standard');
  assert.equal(fourthPass.target.model, 'MiniMax-M3');
  assert.equal(fourthPass.target.api, 'anthropic');
});

test('pass 3 can restore DeepSeek Pro via ORVEX_PASS3_ON_DEEPSEEK_PRO', (t) => {
  const previous = process.env.ORVEX_PASS3_ON_DEEPSEEK_PRO;
  process.env.ORVEX_PASS3_ON_DEEPSEEK_PRO = '1';
  t.after(() => {
    if (previous === undefined) delete process.env.ORVEX_PASS3_ON_DEEPSEEK_PRO;
    else process.env.ORVEX_PASS3_ON_DEEPSEEK_PRO = previous;
  });
  const config = modelRoutingConfig();
  const thirdPass = modelForPass(config, { modelTier: 'multi-model' }, 2);
  assert.equal(thirdPass.tier, 'deepseek');
  assert.equal(thirdPass.target.model, 'deepseek-v4-pro');
});

test('verification usage is charged to DeepSeek v4 Flash by default', (t) => {
  const previousStandard = process.env.ORVEX_VERIFY_ON_STANDARD;
  const previousOpenAi = process.env.ORVEX_VERIFY_ON_OPENAI;
  const previousPro = process.env.ORVEX_VERIFY_ON_DEEPSEEK_PRO;
  delete process.env.ORVEX_VERIFY_ON_STANDARD;
  delete process.env.ORVEX_VERIFY_ON_OPENAI;
  delete process.env.ORVEX_VERIFY_ON_DEEPSEEK_PRO;
  t.after(() => {
    if (previousStandard === undefined) delete process.env.ORVEX_VERIFY_ON_STANDARD;
    else process.env.ORVEX_VERIFY_ON_STANDARD = previousStandard;
    if (previousOpenAi === undefined) delete process.env.ORVEX_VERIFY_ON_OPENAI;
    else process.env.ORVEX_VERIFY_ON_OPENAI = previousOpenAi;
    if (previousPro === undefined) delete process.env.ORVEX_VERIFY_ON_DEEPSEEK_PRO;
    else process.env.ORVEX_VERIFY_ON_DEEPSEEK_PRO = previousPro;
  });

  const config = modelRoutingConfig();
  const flash = modelForPlanWithTier(config, { modelTier: 'multi-model' });
  assert.equal(flash.tier, 'deepseek-flash');
  assert.equal(flash.target.model, 'deepseek-v4-flash');

  const dual = modelForPlanWithTier(config, { modelTier: 'dual-model' });
  assert.equal(dual.tier, 'deepseek-flash');
  assert.equal(dual.target.model, 'deepseek-v4-flash');

  process.env.ORVEX_VERIFY_ON_DEEPSEEK_PRO = '1';
  const pro = modelForPlanWithTier(config, { modelTier: 'multi-model' });
  assert.equal(pro.tier, 'deepseek');
  assert.equal(pro.target.model, 'deepseek-v4-pro');

  delete process.env.ORVEX_VERIFY_ON_DEEPSEEK_PRO;
  process.env.ORVEX_VERIFY_ON_STANDARD = '1';
  const standard = modelForPlanWithTier(config, { modelTier: 'multi-model' });
  assert.equal(standard.tier, 'standard');
  assert.equal(standard.target.model, 'MiniMax-M3');

  delete process.env.ORVEX_VERIFY_ON_STANDARD;
  process.env.ORVEX_VERIFY_ON_OPENAI = '1';
  const openai = modelForPlanWithTier(config, { modelTier: 'multi-model' });
  assert.equal(openai.tier, 'openai');
  assert.equal(openai.target.model, 'gpt-5.6-luna');
});

test('dual-model discovery is MiniMax general + Flash deep-dive', () => {
  const config = modelRoutingConfig();
  const general = modelForPass(config, { modelTier: 'dual-model' }, 0);
  assert.equal(general.tier, 'standard');
  assert.equal(general.target.model, 'MiniMax-M3');
  const deepDive = modelForPass(config, { modelTier: 'dual-model' }, 1);
  assert.equal(deepDive.tier, 'deepseek-flash');
  assert.equal(deepDive.target.model, 'deepseek-v4-flash');
});

test('dual-model deep-dive falls back Flash → Pro → MiniMax', () => {
  const withProOnly = {
    ...modelRoutingConfig(),
    deepseekFlashModel: null,
  };
  const pro = modelForPass(withProOnly, { modelTier: 'dual-model' }, 1);
  assert.equal(pro.tier, 'deepseek');
  assert.equal(pro.target.model, 'deepseek-v4-pro');

  const minimaxOnly = {
    ...modelRoutingConfig(),
    deepseekFlashModel: null,
    deepseekModel: null,
  };
  const standard = modelForPass(minimaxOnly, { modelTier: 'dual-model' }, 1);
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

test('canRunInvestigate: multi-model only, not dual-model, not when Codex agentic', (t) => {
  const prev = process.env.ORVEX_INVESTIGATE;
  t.after(() => {
    if (prev === undefined) delete process.env.ORVEX_INVESTIGATE;
    else process.env.ORVEX_INVESTIGATE = prev;
  });
  delete process.env.ORVEX_INVESTIGATE;

  // Dual-model stays MiniMax + Flash discovery + Flash verify — no investigate.
  assert.equal(canRunInvestigate({ id: 'review', modelTier: 'dual-model' }, { useCodexCli: false }), false);
  assert.equal(canRunInvestigate({ id: 'review-plus', modelTier: 'dual-model' }, { useCodexCli: false }), false);
  assert.equal(canRunInvestigate({ id: 'free', modelTier: 'dual-model' }, { useCodexCli: false }), false);
  assert.equal(canRunInvestigate({ id: 'verify', modelTier: 'multi-model' }, { useCodexCli: false }), true);
  assert.equal(canRunInvestigate({ id: 'verify-lite', modelTier: 'multi-model' }, { useCodexCli: false }), true);
  assert.equal(canRunInvestigate({ id: 'enterprise', modelTier: 'multi-model' }, { useCodexCli: false }), true);
  assert.equal(canRunInvestigate({ id: 'enterprise', modelTier: 'codex-hybrid' }, { useCodexCli: false }), true);
  assert.equal(canRunInvestigate({ id: 'verify', modelTier: 'multi-model' }, { useCodexCli: true }), false);

  process.env.ORVEX_INVESTIGATE = '0';
  assert.equal(canRunInvestigate({ id: 'verify', modelTier: 'multi-model' }, { useCodexCli: false }), false);
});

test('canRunRiskHunt: dual+multi when high-risk and Flash present; kill-switch works', (t) => {
  const prev = process.env.ORVEX_RISK_HUNT;
  t.after(() => {
    if (prev === undefined) delete process.env.ORVEX_RISK_HUNT;
    else process.env.ORVEX_RISK_HUNT = prev;
  });
  delete process.env.ORVEX_RISK_HUNT;

  assert.equal(
    canRunRiskHunt({ modelTier: 'dual-model' }, { highRisk: true, hasFlash: true }),
    true,
  );
  assert.equal(
    canRunRiskHunt({ modelTier: 'multi-model' }, { highRisk: true, hasFlash: true }),
    true,
  );
  assert.equal(
    canRunRiskHunt({ modelTier: 'dual-model' }, { highRisk: false, hasFlash: true }),
    false,
  );
  assert.equal(
    canRunRiskHunt({ modelTier: 'dual-model' }, { highRisk: true, hasFlash: false }),
    false,
  );
  assert.equal(
    canRunRiskHunt({ modelTier: 'standard' }, { highRisk: true, hasFlash: true }),
    false,
  );

  process.env.ORVEX_RISK_HUNT = '0';
  assert.equal(
    canRunRiskHunt({ modelTier: 'multi-model' }, { highRisk: true, hasFlash: true }),
    false,
  );
});

test('modelForRiskHunt prefers DeepSeek v4 Flash and refuses MiniMax fallback', () => {
  const withFlash = {
    deepseekFlashModel: {
      apiKey: 'k',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
      reasoningEffort: 'max',
    },
    deepseekModel: {
      apiKey: 'k',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'max',
    },
    openaiModel: { apiKey: 'o', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.6-luna' },
    standardModel: { apiKey: 's', baseUrl: 'https://x/v1', model: 'MiniMax-M3' },
  } as WorkerConfig;
  assert.equal(modelForRiskHunt(withFlash)?.tier, 'deepseek-flash');

  const noFlash = {
    deepseekFlashModel: null,
    deepseekModel: {
      apiKey: 'k',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-pro',
    },
    openaiModel: { apiKey: 'o', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.6-luna' },
    standardModel: { apiKey: 's', baseUrl: 'https://x/v1', model: 'MiniMax-M3' },
  } as unknown as WorkerConfig;
  assert.equal(modelForRiskHunt(noFlash), null);
});

test('modelForInvestigate prefers DeepSeek v4 Flash', () => {
  const config = {
    deepseekFlashModel: {
      apiKey: 'k',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
      reasoningEffort: 'max',
    },
    deepseekModel: {
      apiKey: 'k',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'max',
    },
    openaiModel: { apiKey: 'o', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.6-luna' },
    standardModel: { apiKey: 's', baseUrl: 'https://x/v1', model: 'MiniMax-M3' },
  } as WorkerConfig;

  const picked = modelForInvestigate(config);
  assert.equal(picked?.tier, 'deepseek-flash');
  assert.equal(picked?.target.model, 'deepseek-v4-flash');
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

test('buildReviewPassAngles: ordinary Verify PRs skip removed-behavior and breadth', (t) => {
  t.after(() => {
    delete process.env.ORVEX_BREADTH_ON;
    delete process.env.ORVEX_REMOVED_BEHAVIOR;
    delete process.env.ORVEX_LARGE_PR_FILES;
    delete process.env.ORVEX_LARGE_PR_PATCH_CHARS;
  });
  delete process.env.ORVEX_BREADTH_ON;
  delete process.env.ORVEX_REMOVED_BEHAVIOR;
  delete process.env.ORVEX_LARGE_PR_FILES;
  delete process.env.ORVEX_LARGE_PR_PATCH_CHARS;
  const small = [{ filename: 'a.ts', patch: '+x\n', status: 'modified' }];
  assert.deepEqual(
    buildReviewPassAngles({ modelTier: 'multi-model', files: small }).map((a) => a.tag),
    ['general', 'deep-dive'],
  );
  const withDelete = [
    ...small,
    { filename: 'gone.ts', patch: '-old\n', status: 'removed' },
  ];
  assert.deepEqual(
    buildReviewPassAngles({ modelTier: 'multi-model', files: withDelete }).map((a) => a.tag),
    ['general', 'deep-dive', 'removed-behavior/callers'],
  );
  process.env.ORVEX_LARGE_PR_FILES = '1';
  assert.deepEqual(
    buildReviewPassAngles({ modelTier: 'multi-model', files: small }).map((a) => a.tag),
    ['general', 'deep-dive', 'perf/completeness/api'],
  );
  // Dual-model never gets the fourth-tier removed-behavior lens, even with deletes.
  delete process.env.ORVEX_LARGE_PR_FILES;
  assert.deepEqual(
    buildReviewPassAngles({ modelTier: 'dual-model', files: withDelete }).map((a) => a.tag),
    ['general', 'deep-dive'],
  );
  process.env.ORVEX_BREADTH_ON = 'always';
  process.env.ORVEX_REMOVED_BEHAVIOR = 'always';
  assert.deepEqual(
    buildReviewPassAngles({ modelTier: 'multi-model', files: small }).map((a) => a.tag),
    ['general', 'deep-dive', 'removed-behavior/callers', 'perf/completeness/api'],
  );
});

test('selectRiskProbes: second probe only when top signal is selective', (t) => {
  t.after(() => {
    delete process.env.ORVEX_RISK_PROBE_SELECTIVITY;
  });
  const wide = [
    { id: 'a', files: ['a.ts', 'b.ts', 'c.ts', 'd.ts'] },
    { id: 'b', files: ['e.ts', 'f.ts', 'g.ts', 'h.ts'] },
  ];
  assert.deepEqual(
    selectRiskProbes(wide, 2).map((s) => s.id),
    ['a'],
  );
  const narrow = [
    { id: 'a', files: ['a.ts'] },
    { id: 'b', files: ['b.ts', 'c.ts', 'd.ts', 'e.ts'] },
  ];
  assert.deepEqual(
    selectRiskProbes(narrow, 2).map((s) => s.id),
    ['a', 'b'],
  );
  assert.deepEqual(selectRiskProbes(narrow, 1).map((s) => s.id), ['a']);
  assert.deepEqual(selectRiskProbes([], 2), []);
});

test('maxRiskProbes: only the top tiers may take a second hypothesis probe', (t) => {
  t.after(() => {
    delete process.env.ORVEX_RISK_PROBES;
  });
  assert.equal(maxRiskProbes({ modelTier: 'codex-hybrid' }), 2);
  assert.equal(maxRiskProbes({ modelTier: 'multi-model' }), 2);
  // Lower tiers keep costing exactly what the single hunting pass cost before.
  assert.equal(maxRiskProbes({ modelTier: 'dual-model' }), 1);

  process.env.ORVEX_RISK_PROBES = '0';
  assert.equal(maxRiskProbes({ modelTier: 'multi-model' }), 0);
  process.env.ORVEX_RISK_PROBES = '9';
  assert.equal(maxRiskProbes({ modelTier: 'multi-model' }), 4);
  process.env.ORVEX_RISK_PROBES = 'nonsense';
  assert.equal(maxRiskProbes({ modelTier: 'multi-model' }), 2);
});
