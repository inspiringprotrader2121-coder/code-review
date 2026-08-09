import assert from 'node:assert/strict';
import test from 'node:test';
import { compileReviewPlan, reviewPlanStages } from './review-plan.js';

test('golden public routing matrix keeps each tier on its declared model slots', () => {
  const cases = [
    {
      tier: 'dual-model',
      stages: [
        'minimax-general:minimax',
        'flash-deep-dive:deepseek-flash',
        'flash-verification:deepseek-flash',
      ],
    },
    {
      tier: 'multi-model',
      stages: [
        'luna-agentic:luna',
        'flash-deep-dive:deepseek-flash',
        'flash-removed-behavior:deepseek-flash',
        'minimax-breadth:minimax',
        'flash-verification:deepseek-flash',
      ],
    },
  ] as const;

  for (const entry of cases) {
    const plan = compileReviewPlan(entry.tier);
    assert.ok(plan, `${entry.tier} must compile`);
    assert.deepEqual(
      reviewPlanStages(plan).map((stage) => `${stage.id}:${stage.modelSlot}`),
      entry.stages,
    );
    assert.ok(reviewPlanStages(plan).every((stage) => stage.required));
  }
  assert.equal(compileReviewPlan('unknown'), null);
});
