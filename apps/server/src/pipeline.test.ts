import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canRunAgentic,
  canRunInvestigate,
  canRunRiskHunt,
  createReviewRoutingPolicy,
  createUsageCostPolicy,
  accountUsage,
  buildReviewPassAngles,
  effectiveReviewConfig,
  failedRequiredCoverageKeys,
  failedRequiredLensIds,
  contextForReviewPass,
  maxOutputTokensForModel,
  modelForInvestigate,
  maxRiskProbes,
  mayPublishRuntimeEvidence,
  modelForRiskHunt,
  providerConfigurationIssue,
  runPostPublicationStep,
  selectRiskProbes,
  usageProvider,
  validateNativeOpenAiResponsesConfig,
  type WorkerConfig,
} from './pipeline.js';
import { compileReviewPlan, isHedgedRejection, isTransientLlmError } from '@orvex-review/review';
import { planFeatures } from '@orvex-review/tenants';
import { createProviderCatalog } from './review/provider-catalog.js';

function modelRoutingConfig(): WorkerConfig {
  return {
    standardModel: {
      apiKey: 'standard-key',
      baseUrl: 'https://api.minimax.io/anthropic',
      model: 'MiniMax-M3',
      api: 'anthropic',
      transport: 'anthropic',
      admissionBucket: 'minimax',
      thinking: true,
      maxTokens: maxOutputTokensForModel('MiniMax-M3'),
    },
    openaiModel: {
      apiKey: 'openai-key',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5.6-luna',
      api: 'responses',
      transport: 'responses',
      admissionBucket: 'luna',
      thinking: true,
      reasoningEffort: 'max',
    },
    codexCliModel: {
      apiKey: '',
      model: 'gpt-5.6-luna',
      transport: 'codex-cli',
      admissionBucket: 'luna',
      thinking: true,
      reasoningEffort: 'max',
    },
    deepseekModel: {
      apiKey: 'deepseek-key',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-pro',
      api: 'chat',
      transport: 'compatible-chat',
      admissionBucket: 'deepseek',
      thinking: true,
      reasoningEffort: 'max',
      maxTokens: maxOutputTokensForModel('deepseek-v4-pro'),
    },
    deepseekFlashModel: {
      apiKey: 'deepseek-flash-key',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
      api: 'chat',
      transport: 'compatible-chat',
      admissionBucket: 'deepseek',
      thinking: true,
      reasoningEffort: 'max',
      maxTokens: maxOutputTokensForModel('deepseek-v4-flash'),
    },
  } as WorkerConfig;
}

test('required paid model stacks fail closed when a provider is missing', () => {
  const config = modelRoutingConfig();
  const policy = createReviewRoutingPolicy({
    codexCliEnabled: true,
    codexRepoAllowed: (repoId) => repoId.toLowerCase() === 'acme/api',
  });
  assert.equal(
    providerConfigurationIssue(planFeatures('verify'), config, 'acme/api', policy),
    null,
  );
  const missingFrontier = providerConfigurationIssue(planFeatures('verify'), {
    ...config,
    openaiModel: null,
    codexCliModel: null,
  });
  assert.ok(missingFrontier);
  assert.match(missingFrontier, /Luna review provider/);
  const missingIndependent = providerConfigurationIssue(planFeatures('review'), {
    ...config,
    deepseekModel: null,
    deepseekFlashModel: null,
  });
  assert.ok(missingIndependent);
  assert.match(missingIndependent, /DeepSeek v4 Flash review provider/);

  assert.match(
    providerConfigurationIssue(planFeatures('review'), {
      ...config,
      standardModel: { ...config.standardModel, model: 'claude-sonnet' },
    }) ?? '',
    /MiniMax review provider/,
  );
  assert.match(
    providerConfigurationIssue(planFeatures('verify'), {
      ...config,
      openaiModel: { ...config.openaiModel!, model: 'expensive-substitute' },
      codexCliModel: null,
    }) ?? '',
    /Luna review provider/,
  );
  assert.match(
    providerConfigurationIssue(planFeatures('review'), {
      ...config,
      deepseekFlashModel: { ...config.deepseekFlashModel!, model: 'deepseek-v4-pro' },
    }) ?? '',
    /DeepSeek v4 Flash review provider/,
  );
});

test('high-tier preflight requires Codex CLI and an admitted repository, never direct Luna', () => {
  const config = modelRoutingConfig();
  const disabled = createReviewRoutingPolicy({
    codexRepoAllowed: (repoId) => repoId.toLowerCase() === 'allowlisted/repo',
  });
  assert.match(
    providerConfigurationIssue(planFeatures('verify'), config, 'allowlisted/repo', disabled) ?? '',
    /Luna review provider/,
  );

  const enabled = createReviewRoutingPolicy({
    codexCliEnabled: true,
    codexRepoAllowed: (repoId) => repoId.toLowerCase() === 'allowlisted/repo',
  });
  assert.match(
    providerConfigurationIssue(planFeatures('verify'), config, 'not/allowlisted', enabled) ?? '',
    /Luna review provider/,
  );
  assert.equal(
    providerConfigurationIssue(planFeatures('verify'), config, 'allowlisted/repo', enabled),
    null,
  );
  assert.match(
    providerConfigurationIssue(
      planFeatures('verify'),
      { ...config, codexCliModel: null },
      'allowlisted/repo',
      enabled,
    ) ?? '',
    /Luna review provider/,
    'direct Responses Luna must not substitute for the CLI contract',
  );
});

test('fixed provider output ceilings bound long maximum-reasoning generations', () => {
  const defaults = createReviewRoutingPolicy({});
  assert.equal(maxOutputTokensForModel('deepseek-v4-flash', defaults), 128_000);
  assert.equal(maxOutputTokensForModel('MiniMax-M3', defaults), 128_000);
  assert.ok(Object.isFrozen(defaults));
  assert.equal(maxOutputTokensForModel('gpt-5.6-luna', defaults), undefined);
});

test('named public-plan stages are resolved only by the ProviderCatalog', () => {
  const config = modelRoutingConfig();
  const plan = compileReviewPlan('multi-model');
  assert.ok(plan);
  const catalog = createProviderCatalog(config);
  const routed = plan.discovery.map((stage) =>
    catalog.resolveStage(stage, { agenticLuna: stage.modelSlot === 'luna' }),
  );
  assert.deepEqual(
    routed.map((item) => item.target.model),
    ['gpt-5.6-luna', 'deepseek-v4-flash', 'MiniMax-M3'],
  );
  assert.equal(
    catalog.resolveStage(plan.verification, { agenticLuna: false }).target.model,
    'deepseek-v4-flash',
  );
});

test('review lenses rotate changed files and receive only relevant cross-file context', () => {
  const context = {
    treePaths: ['src/a.ts'],
    changedContents: ['a', 'b', 'c', 'd'].map((path) => ({ path, content: path })),
    related: [{ path: 'callee', content: 'callee' }],
    dependents: [{ path: 'caller', content: 'caller' }],
    others: [{ path: 'other', content: 'other' }],
  };

  const deep = contextForReviewPass(context, 1);
  assert.deepEqual(
    deep.changedContents?.map((file) => file.path),
    ['a', 'b', 'c', 'd'],
  );
  assert.ok(deep.related);
  assert.equal(deep.dependents, undefined);
  assert.equal(deep.others, undefined);

  const callers = contextForReviewPass(context, 2);
  assert.deepEqual(
    callers.changedContents?.map((file) => file.path),
    ['d', 'c', 'b', 'a'],
  );
  assert.ok(callers.dependents);
  assert.equal(callers.related, undefined);
  assert.equal(callers.others, undefined);

  const breadth = contextForReviewPass(context, 3);
  assert.deepEqual(
    breadth.changedContents?.map((file) => file.path),
    ['c', 'd', 'a', 'b'],
  );
  assert.ok(breadth.related);
  assert.ok(breadth.others);
  assert.equal(breadth.dependents, undefined);
});

test('usage accounting clamps malformed provider token counts instead of poisoning cost totals', () => {
  const accounted = accountUsage('standard', modelRoutingConfig().standardModel, 'discovery', {
    inputTokens: Number.NaN,
    outputTokens: -10,
    tokenSource: 'provider',
  });
  assert.equal(accounted.inputTokens, 0);
  assert.equal(accounted.outputTokens, 0);
  assert.equal(accounted.costUsd, 0);
});

test('usage accounting keeps Luna pricing pinned and prices provider cache reads and writes separately', () => {
  const staleGenericOpenAi = createUsageCostPolicy({
    openai: { input: 1, cachedInput: 0.1, output: 6 },
  });
  const luna = accountUsage(
    'openai',
    modelRoutingConfig().openaiModel,
    'agentic discovery',
    { inputTokens: 50_000, outputTokens: 5_000, tokenSource: 'estimate' },
    staleGenericOpenAi,
  );
  assert.equal(luna.inputRatePerM, 1);
  assert.equal(luna.cachedInputRatePerM, 0.1);
  assert.equal(luna.cacheWriteRatePerM, 1.25);
  assert.equal(luna.outputRatePerM, 6);
  assert.equal(luna.costUsd, 0.08);

  const flash = accountUsage(
    'deepseek-flash',
    modelRoutingConfig().deepseekFlashModel,
    'verification',
    { inputTokens: 1_000_000, cachedInputTokens: 900_000, outputTokens: 1_000_000 },
    createUsageCostPolicy({}),
    new Date('2026-08-14T12:00:00Z'),
  );
  assert.equal(flash.costUsd, 0.29652);

  const longLuna = accountUsage('openai', modelRoutingConfig().openaiModel, 'agentic discovery', {
    inputTokens: 300_000,
    cachedInputTokens: 100_000,
    cacheWriteTokens: 50_000,
    outputTokens: 1_000_000,
    tokenSource: 'provider',
  });
  assert.equal(longLuna.inputRatePerM, 2);
  assert.equal(longLuna.cachedInputRatePerM, 0.2);
  assert.equal(longLuna.cacheWriteRatePerM, 2.5);
  assert.ok(Math.abs(longLuna.outputRatePerM - 9) < 1e-12);
  assert.ok(Math.abs(longLuna.costUsd - 9.445) < 1e-12);

  const longMiniMax = accountUsage('standard', modelRoutingConfig().standardModel, 'discovery', {
    inputTokens: 600_000,
    outputTokens: 100_000,
    tokenSource: 'provider',
  });
  assert.equal(longMiniMax.inputRatePerM, 0.6);
  assert.equal(longMiniMax.cachedInputRatePerM, 0.12);
  assert.equal(longMiniMax.outputRatePerM, 2.4);
  assert.equal(longMiniMax.costUsd, 0.6);
});

test('post-publication finalizers are non-fatal after GitHub accepted a review', async () => {
  assert.equal(await runPostPublicationStep('test', () => {}), true);
  assert.equal(
    await runPostPublicationStep('test failure', () => {
      throw new Error('database unavailable');
    }),
    false,
  );
});

test('runtime evidence requires a fresh lease and an un-cancelled open PR', async () => {
  const controller = new AbortController();
  let openChecks = 0;
  assert.equal(
    await mayPublishRuntimeEvidence(
      controller.signal,
      async () => false,
      async () => {
        openChecks++;
        return true;
      },
    ),
    false,
  );
  assert.equal(openChecks, 0, 'lease loss must prevent the GitHub evidence check and comment');

  const cancelled = new AbortController();
  cancelled.abort('review closed');
  assert.equal(
    await mayPublishRuntimeEvidence(
      cancelled.signal,
      async () => true,
      async () => {
        assert.fail('cancelled reviews must not check or comment');
      },
    ),
    false,
  );

  assert.equal(
    await mayPublishRuntimeEvidence(
      controller.signal,
      async () => true,
      async () => true,
    ),
    true,
  );
});

test('usage attribution labels the default no-base-url client as Anthropic', () => {
  assert.equal(
    usageProvider(
      {
        apiKey: 'key',
        model: 'claude-sonnet',
        api: undefined,
        transport: 'anthropic',
        admissionBucket: 'anthropic',
        thinking: false,
      },
      'review',
    ),
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

test('Verify routes all paid public stages through the catalog', () => {
  const high = createProviderCatalog(modelRoutingConfig()).compilePublicPlan('multi-model', {
    agenticLuna: true,
  });
  assert.ok(high);
  assert.deepEqual(
    high.discovery.map((stage) => [stage.tier, stage.target.model, stage.target.apiKey]),
    [
      ['openai', 'gpt-5.6-luna', ''],
      ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-flash-key'],
      ['standard', 'MiniMax-M3', 'standard-key'],
    ],
  );
  assert.equal(high.verification.target.model, 'deepseek-v4-flash');
});

test('direct Luna diagnostics accept only native HTTPS Responses configuration', () => {
  assert.equal(
    validateNativeOpenAiResponsesConfig('https://api.openai.com/v1', 'responses'),
    'https://api.openai.com/v1',
  );
  assert.throws(
    () => validateNativeOpenAiResponsesConfig('https://openrouter.ai/api/v1', 'responses'),
    /gateways and custom paths are refused/,
  );
  assert.throws(
    () => validateNativeOpenAiResponsesConfig('http://api.openai.com/v1', 'responses'),
    /gateways and custom paths are refused/,
  );
  assert.throws(
    () => validateNativeOpenAiResponsesConfig('https://api.openai.com/v1', 'chat'),
    /Responses API/,
  );
});

test('public-plan catalog fixes Flash verification and refuses incomplete provider stacks', () => {
  const config = modelRoutingConfig();
  const catalog = createProviderCatalog(config);
  assert.equal(
    catalog.compilePublicPlan('multi-model', { agenticLuna: true })?.verification.target.model,
    'deepseek-v4-flash',
  );
  assert.equal(
    catalog.compilePublicPlan('dual-model', { agenticLuna: false })?.verification.target.model,
    'deepseek-v4-flash',
  );
  assert.throws(
    () =>
      createProviderCatalog({ ...config, deepseekFlashModel: null }).compilePublicPlan(
        'multi-model',
        { agenticLuna: true },
      ),
    /Flash is required/,
  );
});

test('canRunAgentic is driven by an injected fail-closed repository policy', () => {
  const allowlisted = createReviewRoutingPolicy({
    codexCliEnabled: true,
    codexRepoAllowed: (repoId) => repoId.toLowerCase() === 'acme/api',
  });
  assert.equal(canRunAgentic({ modelTier: 'multi-model' }, 'acme/api', allowlisted), true);
  assert.equal(
    canRunAgentic({ modelTier: 'multi-model' }, 'ACME/API', allowlisted),
    true,
    'allowlist is case-insensitive',
  );

  assert.equal(canRunAgentic({ modelTier: 'multi-model' }, 'evil/repo', allowlisted), false);
  assert.equal(canRunAgentic({ modelTier: 'standard' }, 'acme/api', allowlisted), false);
  const disabled = createReviewRoutingPolicy({
    codexCliEnabled: false,
    codexRepoAllowed: () => true,
  });
  assert.equal(canRunAgentic({ modelTier: 'multi-model' }, 'acme/api', disabled), false);
  const noAllowlist = createReviewRoutingPolicy({ codexCliEnabled: true });
  assert.equal(
    canRunAgentic({ modelTier: 'multi-model' }, 'acme/api', noAllowlist),
    false,
    'unset policy predicate = never',
  );

  assert.equal(canRunAgentic({ modelTier: 'multi-model' }, 'tenant/repo', noAllowlist), false);
});

test('canRunInvestigate: multi-model only, not dual-model, not when Codex agentic', () => {
  const disabled = createReviewRoutingPolicy({ investigateEnabled: false });
  const enabled = createReviewRoutingPolicy({ investigateEnabled: true });

  // Dual-model stays MiniMax + Flash discovery + Flash verify — no investigate.
  assert.equal(
    canRunInvestigate({ id: 'review', modelTier: 'dual-model' }, { useCodexCli: false }, enabled),
    false,
  );
  assert.equal(
    canRunInvestigate(
      { id: 'review-plus', modelTier: 'dual-model' },
      { useCodexCli: false },
      enabled,
    ),
    false,
  );
  assert.equal(
    canRunInvestigate({ id: 'free', modelTier: 'dual-model' }, { useCodexCli: false }, enabled),
    false,
  );
  assert.equal(
    canRunInvestigate({ id: 'verify', modelTier: 'multi-model' }, { useCodexCli: false }, disabled),
    false,
  );
  assert.equal(
    canRunInvestigate(
      { id: 'verify-lite', modelTier: 'multi-model' },
      { useCodexCli: false },
      enabled,
    ),
    true,
  );
  assert.equal(
    canRunInvestigate(
      { id: 'enterprise', modelTier: 'multi-model' },
      { useCodexCli: false },
      enabled,
    ),
    true,
  );
  assert.equal(
    canRunInvestigate(
      { id: 'enterprise', modelTier: 'codex-hybrid' },
      { useCodexCli: false },
      enabled,
    ),
    true,
  );
  assert.equal(
    canRunInvestigate({ id: 'verify', modelTier: 'multi-model' }, { useCodexCli: true }, enabled),
    false,
  );
});

test('canRunRiskHunt: opt-in only, then dual+multi when high-risk and Flash present', () => {
  const disabled = createReviewRoutingPolicy({ riskHuntEnabled: false });
  const enabled = createReviewRoutingPolicy({ riskHuntEnabled: true });

  assert.equal(
    canRunRiskHunt({ modelTier: 'dual-model' }, { highRisk: true, hasFlash: true }, disabled),
    false,
  );
  assert.equal(
    canRunRiskHunt({ modelTier: 'multi-model' }, { highRisk: true, hasFlash: true }, enabled),
    true,
  );
  assert.equal(
    canRunRiskHunt({ modelTier: 'dual-model' }, { highRisk: false, hasFlash: true }, enabled),
    false,
  );
  assert.equal(
    canRunRiskHunt({ modelTier: 'dual-model' }, { highRisk: true, hasFlash: false }, enabled),
    false,
  );
  assert.equal(
    canRunRiskHunt({ modelTier: 'standard' }, { highRisk: true, hasFlash: true }, enabled),
    false,
  );

  assert.equal(
    canRunRiskHunt({ modelTier: 'multi-model' }, { highRisk: true, hasFlash: true }, disabled),
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

test('public-plan catalog fails closed when Luna cannot run agentically', () => {
  const config = modelRoutingConfig();
  assert.throws(
    () => createProviderCatalog(config).compilePublicPlan('multi-model', { agenticLuna: false }),
    /pinned Codex CLI/,
  );
  assert.equal(
    createProviderCatalog(config).compilePublicPlan('multi-model', { agenticLuna: true })
      ?.discovery[0]?.target.apiKey,
    '',
  );
});

test('a timed-out required pass stays transient; a genuine failure does not', () => {
  // Keep the classification available for an operator-enabled bounded recovery
  // policy even though automatic whole-review replay is off by default.
  assert.equal(
    isTransientLlmError(
      'review aborted: 1/2 required review lens(es) completed fewer than 1 sample(s) — required provider call timed out or was temporarily unavailable',
    ),
    true,
    'a transient cause must remain distinguishable',
  );
  assert.equal(
    isTransientLlmError(
      'review aborted: 1/2 required model pass(es) failed; no partial review was posted',
    ),
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

test('a successful required chunk cannot satisfy a failed sibling chunk', () => {
  const failed = failedRequiredCoverageKeys(
    ['required:deep-dive:1:chunk:1/2', 'required:deep-dive:1:chunk:2/2'],
    [
      { requiredCoverageKey: 'required:deep-dive:1:chunk:1/2', ok: true },
      { requiredCoverageKey: 'required:deep-dive:1:chunk:2/2', ok: false },
    ],
    1,
  );

  assert.deepEqual(failed, ['required:deep-dive:1:chunk:2/2']);
});

test('buildReviewPassAngles: multi-model always runs the full three-pass track', (t) => {
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
  // Verify/Enterprise multi-model: full track even on tiny PRs.
  assert.deepEqual(
    buildReviewPassAngles({ modelTier: 'multi-model', files: small }).map((a) => a.tag),
    ['general', 'deep-dive', 'perf/completeness/api'],
  );
  assert.ok(
    buildReviewPassAngles({ modelTier: 'multi-model', files: small }).every((a) => !a.bestEffort),
    'all three purchased high-tier reviewer stages are required',
  );
  // Dual-model never gets the high-tier breadth lens.
  const withDelete = [...small, { filename: 'gone.ts', patch: '-old\n', status: 'removed' }];
  assert.deepEqual(
    buildReviewPassAngles({ modelTier: 'dual-model', files: withDelete }).map((a) => a.tag),
    ['general', 'deep-dive'],
  );
  // Stale conditional flags cannot reduce the purchased three-pass track.
  process.env.ORVEX_BREADTH_ON = 'deep-or-large';
  process.env.ORVEX_REMOVED_BEHAVIOR = 'deletes-or-renames';
  assert.deepEqual(
    buildReviewPassAngles({ modelTier: 'multi-model', files: small }).map((a) => a.tag),
    ['general', 'deep-dive', 'perf/completeness/api'],
  );
  assert.deepEqual(
    buildReviewPassAngles({ modelTier: 'multi-model', files: withDelete }).map((a) => a.tag),
    ['general', 'deep-dive', 'perf/completeness/api'],
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
  assert.deepEqual(
    selectRiskProbes(narrow, 1).map((s) => s.id),
    ['a'],
  );
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
