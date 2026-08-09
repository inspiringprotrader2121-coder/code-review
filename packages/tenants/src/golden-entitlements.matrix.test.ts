import assert from 'node:assert/strict';
import test from 'node:test';
import { PLANS, type PlanId } from './plans.js';
import { hasPlanCapability, reviewEntitlement } from './policy.js';

test('golden entitlement matrix covers every public plan decision', () => {
  const cases: Record<
    PlanId,
    { modelTier: string; passes: number; priority: number; deep: boolean; nightly: boolean }
  > = {
    free: { modelTier: 'dual-model', passes: 2, priority: 0, deep: false, nightly: false },
    review: { modelTier: 'dual-model', passes: 2, priority: 1, deep: true, nightly: true },
    'review-plus': { modelTier: 'dual-model', passes: 2, priority: 1, deep: true, nightly: true },
    'verify-lite': { modelTier: 'multi-model', passes: 4, priority: 2, deep: true, nightly: true },
    verify: { modelTier: 'multi-model', passes: 4, priority: 3, deep: true, nightly: true },
    enterprise: { modelTier: 'multi-model', passes: 4, priority: 4, deep: true, nightly: true },
  };

  for (const planId of Object.keys(cases) as PlanId[]) {
    const plan = PLANS[planId];
    const expected = cases[planId];
    const entitlement = reviewEntitlement(plan);
    assert.deepEqual(
      {
        modelTier: entitlement.modelTier,
        passes: entitlement.discoveryPasses,
        priority: entitlement.queuePriority,
      },
      { modelTier: expected.modelTier, passes: expected.passes, priority: expected.priority },
      planId,
    );
    assert.equal(hasPlanCapability(plan, 'review:deep'), expected.deep, `${planId} deep`);
    assert.equal(
      hasPlanCapability(plan, 'review:nightly-scan'),
      expected.nightly,
      `${planId} nightly`,
    );
  }
});
