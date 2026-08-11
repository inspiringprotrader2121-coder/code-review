import type { ProviderCapacityPlan } from './provider-admission.js';
import {
  FLEET_TENANT_CONCURRENCY_FIELD,
  fleetCapacityRegistryKey,
} from './redis-provider-admission.js';

/**
 * Queue-claim information shared by dequeue, terminal transitions, and
 * recovery. Keeping it separate from provider calls makes tenant fairness
 * enforceable before a worker starts any paid review stage.
 */
export interface RedisTenantAdmission {
  readonly enabled: boolean;
  readonly capacityKey: string;
  readonly capacityField: typeof FLEET_TENANT_CONCURRENCY_FIELD;
}

export function createRedisTenantAdmission(
  namespace: string,
  plan: ProviderCapacityPlan | undefined,
): RedisTenantAdmission {
  return Object.freeze({
    enabled: plan?.tenantConcurrency !== undefined,
    // Legacy direct queue construction intentionally stays local/unlimited.
    // Production composition always supplies a scheduler-owned plan.
    capacityKey: plan
      ? fleetCapacityRegistryKey(namespace, plan.epoch)
      : `${namespace}:provider-capacity:legacy`,
    capacityField: FLEET_TENANT_CONCURRENCY_FIELD,
  });
}
