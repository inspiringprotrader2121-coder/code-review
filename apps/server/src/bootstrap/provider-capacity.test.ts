import assert from 'node:assert/strict';
import test from 'node:test';
import { providerCapacityPlanFor } from './provider-capacity.js';
import { testServerConfig } from './test-config.js';

test('fleet capacity plan separates global provider capacity from local worker lanes', () => {
  const plan = providerCapacityPlanFor(
    testServerConfig({
      ORVEX_PROVIDER_CONCURRENCY_LUNA: '3',
      ORVEX_PROVIDER_CONCURRENCY_DEEPSEEK: '4',
      ORVEX_PROVIDER_CONCURRENCY_MINIMAX: '5',
      ORVEX_FLEET_PROVIDER_CONCURRENCY_LUNA: '64',
      ORVEX_FLEET_PROVIDER_CONCURRENCY_DEEPSEEK: '80',
      ORVEX_FLEET_PROVIDER_CONCURRENCY_MINIMAX: '48',
      ORVEX_FLEET_TENANT_CONCURRENCY: '6',
      ORVEX_FLEET_CAPACITY_EPOCH: 'fleet-2026-08',
    }),
  );

  assert.deepEqual(plan, {
    epoch: 'fleet-2026-08',
    tenantConcurrency: 6,
    limits: { luna: 64, deepseek: 80, minimax: 48 },
  });
  assert.ok(Object.isFrozen(plan));
  assert.ok(Object.isFrozen(plan.limits));
});
