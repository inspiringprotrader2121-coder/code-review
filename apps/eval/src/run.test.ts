import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  evaluationInvestigateEnabled,
  evaluationInvestigateTarget,
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
  const callers = targets.find((target) => target.tag === 'removed-behavior/callers');
  const standard = targets.find((target) => target.tag === 'perf/completeness/api');
  assert.ok(flash);
  assert.ok(callers);
  assert.ok(standard);
  assert.equal(flash.target.reasoningEffort, 'max');
  assert.equal(flash.tier, 'deepseek-flash');
  assert.equal(callers.tier, 'deepseek-flash');
  assert.equal(callers.target.model, 'deepseek-v4-flash');
  assert.equal(standard.target.api, 'responses');
});

test('evaluation pass 3 ignores stale Pro overrides and stays on Flash', () => {
  const targets = evaluationPassTargets({
    ORVEX_STANDARD_API_KEY: 'standard-test-key',
    ORVEX_STANDARD_MODEL: 'standard-test-model',
    ORVEX_OPENAI_API_KEY: 'openai-test-key',
    ORVEX_DEEPSEEK_API_KEY: 'deepseek-test-key',
    ORVEX_PASS3_ON_DEEPSEEK_PRO: '1',
  });
  const callers = targets.find((target) => target.tag === 'removed-behavior/callers');
  assert.ok(callers);
  assert.equal(callers.tier, 'deepseek-flash');
  assert.equal(callers.target.model, 'deepseek-v4-flash');
});

test('evaluationVerifier defaults to DeepSeek Flash and passes the tier for peer-hedge partitioning', () => {
  const flash = evaluationVerifier({
    ORVEX_STANDARD_API_KEY: 'standard-test-key',
    ORVEX_STANDARD_MODEL: 'standard-test-model',
    ORVEX_DEEPSEEK_API_KEY: 'deepseek-test-key',
  });
  assert.equal(flash.tier, 'deepseek-flash');
  assert.equal(flash.target.model, 'deepseek-v4-flash');

  const stillFlash = evaluationVerifier({
    ORVEX_STANDARD_API_KEY: 'standard-test-key',
    ORVEX_STANDARD_MODEL: 'standard-test-model',
    ORVEX_DEEPSEEK_API_KEY: 'deepseek-test-key',
    ORVEX_VERIFY_ON_DEEPSEEK_PRO: '1',
  });
  assert.equal(stillFlash.tier, 'deepseek-flash');
  assert.equal(stillFlash.target.model, 'deepseek-v4-flash');
});

test('evaluationInvestigateEnabled mirrors production kill-switch + target resolution', () => {
  assert.equal(
    evaluationInvestigateEnabled({ ORVEX_DEEPSEEK_API_KEY: 'k' }),
    false,
  );
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
  assert.equal(target.target.reasoningEffort, 'max');

  const pro = evaluationInvestigateTarget({
    ORVEX_DEEPSEEK_API_KEY: 'k',
    ORVEX_INVESTIGATE_TIER: 'deepseek',
  });
  assert.ok(pro);
  assert.equal(pro.tier, 'deepseek');
  assert.equal(pro.target.model, 'deepseek-v4-pro');
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
});
