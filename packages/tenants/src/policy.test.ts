import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorkspaceMember } from '@orvex-review/store';
import {
  hasPlanCapability,
  hasTenantCapability,
  isCustomContractPlan,
  mayClaimWorkspace,
  reviewEntitlement,
} from './policy.js';
import { PLANS, type PlanId } from './plans.js';

const member: WorkspaceMember = {
  tenantId: 'tenant-a',
  userId: 'user-a',
  role: 'member',
  createdAt: '2026-01-01T00:00:00.000Z',
};

test('tenant access matrix only grants member-scoped capabilities', () => {
  for (const capability of ['workspace:read', 'workspace:connect'] as const) {
    assert.equal(hasTenantCapability(member, capability), true, `${capability} for members`);
    assert.equal(hasTenantCapability(null, capability), false, `${capability} without membership`);
  }
  assert.equal(mayClaimWorkspace(null, true), true);
  assert.equal(mayClaimWorkspace(member, true), false);
  assert.equal(mayClaimWorkspace(null, false), false);
});

test('plan capability matrix matches the product contract for every tier', () => {
  const expected: Record<PlanId, Record<string, boolean>> = {
    free: { autofix: true, deep: false, runtime: true, strict: true, nightly: false, sweep: false },
    review: { autofix: true, deep: true, runtime: true, strict: true, nightly: true, sweep: false },
    'review-plus': {
      autofix: true,
      deep: true,
      runtime: true,
      strict: true,
      nightly: true,
      sweep: false,
    },
    'verify-lite': {
      autofix: true,
      deep: true,
      runtime: true,
      strict: true,
      nightly: true,
      sweep: false,
    },
    verify: { autofix: true, deep: true, runtime: true, strict: true, nightly: true, sweep: false },
    enterprise: {
      autofix: true,
      deep: true,
      runtime: true,
      strict: true,
      nightly: true,
      sweep: false,
    },
  };
  const capabilities = {
    autofix: 'review:autofix',
    deep: 'review:deep',
    runtime: 'review:runtime-verify',
    strict: 'review:strict-verify',
    nightly: 'review:nightly-scan',
    sweep: 'review:repository-sweep',
  } as const;

  for (const planId of Object.keys(PLANS) as PlanId[]) {
    for (const [name, capability] of Object.entries(capabilities)) {
      assert.equal(
        hasPlanCapability(PLANS[planId], capability),
        expected[planId][name],
        `${planId} ${name}`,
      );
    }
  }
});

test('review entitlement preserves the configured execution profile', () => {
  assert.deepEqual(reviewEntitlement(PLANS.verify), {
    modelTier: 'multi-model',
    discoveryPasses: 3,
    retrievalTopK: 28,
    queuePriority: 3,
  });
  assert.ok(Object.isFrozen(reviewEntitlement(PLANS.free)));
});

test('custom-contract display policy is isolated from plan labels', () => {
  assert.equal(isCustomContractPlan(PLANS.enterprise), true);
  assert.equal(isCustomContractPlan(PLANS.verify), false);
});
