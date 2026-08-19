import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  evaluationInvestigateEnabled,
  evaluationInvestigateTarget,
  evaluationConfigurationFingerprint,
  evaluationModelConfiguration,
  evaluationPassTargets,
  evaluationRiskHuntTarget,
  evaluationVerifier,
} from './run.js';

test('evaluation pass targets mirror the fixed model lineup at max effort', () => {
  const targets = evaluationPassTargets({
    ORVEX_STANDARD_API_KEY: 'standard-test-key',
    ORVEX_STANDARD_MODEL: 'standard-test-model',
    ORVEX_STANDARD_API: 'responses',
    ORVEX_OPENAI_API_KEY: 'openai-test-key',
    ORVEX_DEEPSEEK_API_KEY: 'deepseek-test-key',
    ORVEX_DEEPSEEK_EFFORT: 'high',
    ORVEX_DEEPSEEK_FLASH_EFFORT: 'low',
  });

  const flash = targets.find((target) => target.tag === 'deep-dive');
  const standard = targets.find((target) => target.tag === 'perf/completeness/api');
  assert.ok(flash);
  assert.ok(standard);
  assert.equal(targets.length, 3);
  assert.equal(flash.target.reasoningEffort, 'max');
  assert.equal(flash.target.api, 'responses');
  assert.equal(flash.tier, 'deepseek-flash');
  assert.match(flash.focus ?? '', /REMOVED \/ WEAKENED BEHAVIOUR/);
  assert.match(flash.focus ?? '', /CALLER & CONTRACT AUDIT/);
  assert.equal(standard.target.api, 'responses');
});

test('evaluation combined deep-dive ignores stale Pro overrides and stays on Flash', () => {
  const targets = evaluationPassTargets({
    ORVEX_STANDARD_API_KEY: 'standard-test-key',
    ORVEX_STANDARD_MODEL: 'standard-test-model',
    ORVEX_OPENAI_API_KEY: 'openai-test-key',
    ORVEX_DEEPSEEK_API_KEY: 'deepseek-test-key',
    ORVEX_PASS3_ON_DEEPSEEK_PRO: '1',
  });
  const flash = targets.find((target) => target.tag === 'deep-dive');
  assert.ok(flash);
  assert.equal(flash.tier, 'deepseek-flash');
  assert.equal(flash.target.model, 'deepseek-v4-flash');
  assert.equal(flash.target.api, 'responses');
});

test('evaluationVerifier defaults to DeepSeek Flash and passes the tier for peer-hedge partitioning', () => {
  const flash = evaluationVerifier({
    ORVEX_STANDARD_API_KEY: 'standard-test-key',
    ORVEX_STANDARD_MODEL: 'standard-test-model',
    ORVEX_DEEPSEEK_API_KEY: 'deepseek-test-key',
  });
  assert.equal(flash.tier, 'deepseek-flash');
  assert.equal(flash.target.model, 'deepseek-v4-flash');
  assert.equal(flash.target.api, 'responses');

  const stillFlash = evaluationVerifier({
    ORVEX_STANDARD_API_KEY: 'standard-test-key',
    ORVEX_STANDARD_MODEL: 'standard-test-model',
    ORVEX_DEEPSEEK_API_KEY: 'deepseek-test-key',
    ORVEX_VERIFY_ON_DEEPSEEK_PRO: '1',
  });
  assert.equal(stillFlash.tier, 'deepseek-flash');
  assert.equal(stillFlash.target.model, 'deepseek-v4-flash');
  assert.equal(stillFlash.target.api, 'responses');
});

test('evaluationInvestigateEnabled mirrors production kill-switch + target resolution', () => {
  assert.equal(evaluationInvestigateEnabled({ ORVEX_DEEPSEEK_API_KEY: 'k' }), false);
  assert.equal(
    evaluationInvestigateEnabled({ ORVEX_DEEPSEEK_API_KEY: 'k', ORVEX_INVESTIGATE: '1' }),
    true,
  );
  assert.equal(evaluationInvestigateEnabled({}), false);

  const target = evaluationInvestigateTarget({
    ORVEX_DEEPSEEK_API_KEY: 'k',
    ORVEX_DEEPSEEK_FLASH_MODEL: 'deepseek-v4-flash',
    ORVEX_DEEPSEEK_FLASH_EFFORT: 'max',
  });
  assert.ok(target);
  assert.equal(target.tier, 'deepseek-flash');
  assert.equal(target.target.model, 'deepseek-v4-flash');
  assert.equal(target.target.api, 'responses');
  assert.equal(target.target.reasoningEffort, 'max');

  const pro = evaluationInvestigateTarget({
    ORVEX_DEEPSEEK_API_KEY: 'k',
    ORVEX_INVESTIGATE_TIER: 'deepseek',
  });
  assert.ok(pro);
  assert.equal(pro.tier, 'deepseek');
  assert.equal(pro.target.model, 'deepseek-v4-pro');
  assert.equal(pro.target.api, 'chat');
});

test('evaluationRiskHuntTarget requires Flash and explicit opt-in', () => {
  assert.equal(evaluationRiskHuntTarget({}), null);
  assert.equal(
    evaluationRiskHuntTarget({ ORVEX_DEEPSEEK_API_KEY: 'k', ORVEX_RISK_HUNT: '0' }),
    null,
  );
  const target = evaluationRiskHuntTarget({
    ORVEX_DEEPSEEK_API_KEY: 'k',
    ORVEX_DEEPSEEK_FLASH_MODEL: 'deepseek-v4-flash',
    ORVEX_RISK_HUNT: '1',
  });
  assert.ok(target);
  assert.equal(target.tier, 'deepseek-flash');
  assert.equal(target.target.model, 'deepseek-v4-flash');
  assert.equal(target.target.api, 'responses');
});

test('evaluation records model, transport, and production partition provenance without credentials', () => {
  const config = evaluationModelConfiguration({
    ORVEX_STANDARD_API_KEY: 'secret-standard',
    ORVEX_STANDARD_MODEL: 'MiniMax-test',
    ORVEX_OPENAI_API_KEY: 'secret-openai',
    ORVEX_OPENAI_MODEL: 'luna-test',
    ORVEX_DEEPSEEK_API_KEY: 'secret-deepseek',
    ORVEX_DEEPSEEK_FLASH_MODEL: 'flash-test',
  });
  assert.equal(config.execution, 'controlled-live');
  assert.deepEqual(config.lunaExecution, {
    transport: 'direct-responses-api',
    productionTransport: 'containerized-codex-cli',
    productionEquivalent: false,
  });
  assert.equal(config.claimScope, 'non-production-transport');
  assert.equal(config.normalSurface, 'partitionVerifiedFindings.toPost');
  assert.equal(config.manualSurface, 'partitionVerifiedFindings.reviewOnly');
  assert.equal(config.passes[0]?.model, 'luna-test');
  assert.equal(JSON.stringify(config).includes('secret-'), false);
  assert.match(evaluationConfigurationFingerprint(config), /^[a-f0-9]{64}$/);
});
