import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluationPassTargets } from './run.js';

test('evaluation pass targets mirror production API mode and DeepSeek effort settings', () => {
  const targets = evaluationPassTargets({
    ORVEX_STANDARD_API_KEY: 'standard-test-key',
    ORVEX_STANDARD_MODEL: 'standard-test-model',
    ORVEX_STANDARD_API: 'responses',
    ORVEX_DEEPSEEK_API_KEY: 'deepseek-test-key',
    ORVEX_DEEPSEEK_EFFORT: 'high',
    ORVEX_DEEPSEEK_FLASH_EFFORT: 'low',
  });

  const flash = targets.find((target) => target.tag === 'deep-dive');
  const standard = targets.find((target) => target.tag === 'perf/completeness/api');
  assert.ok(flash);
  assert.ok(standard);
  assert.equal(flash.target.reasoningEffort, 'low');
  assert.equal(standard.target.api, 'responses');
});
