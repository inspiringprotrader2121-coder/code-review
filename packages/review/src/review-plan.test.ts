import assert from 'node:assert/strict';
import test from 'node:test';
import { compileReviewPlan, reviewPlanStages } from './review-plan.js';

test('high-tier plan is three required reviewers followed by Flash verification', () => {
  for (const tier of ['multi-model']) {
    const plan = compileReviewPlan(tier);
    assert.ok(plan);
    assert.deepEqual(
      reviewPlanStages(plan).map((stage) => ({
        id: stage.id,
        model: stage.modelSlot,
        kind: stage.kind,
        required: stage.required,
      })),
      [
        { id: 'luna-agentic', model: 'luna', kind: 'discovery', required: true },
        { id: 'flash-deep-dive', model: 'deepseek-flash', kind: 'discovery', required: true },
        { id: 'minimax-breadth', model: 'minimax', kind: 'discovery', required: true },
        { id: 'flash-verification', model: 'deepseek-flash', kind: 'verification', required: true },
      ],
    );
    assert.match(plan.discovery[1]?.focus ?? '', /REMOVED \/ WEAKENED BEHAVIOUR/);
    assert.match(plan.discovery[1]?.focus ?? '', /CALLER & CONTRACT AUDIT/);
  }
});

test('lower-tier plan is MiniMax and Flash followed by Flash verification', () => {
  const plan = compileReviewPlan('dual-model');
  assert.ok(plan);
  assert.deepEqual(
    [...plan.discovery, plan.verification].map((stage) => `${stage.kind}:${stage.modelSlot}`),
    ['discovery:minimax', 'discovery:deepseek-flash', 'verification:deepseek-flash'],
  );
});

test('legacy tiers remain outside the fixed public-plan compiler', () => {
  assert.equal(compileReviewPlan('standard'), null);
  assert.equal(compileReviewPlan('codex-hybrid'), null);
  assert.equal(compileReviewPlan(undefined), null);
});
