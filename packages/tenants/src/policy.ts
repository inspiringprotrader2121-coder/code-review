import type { WorkspaceMember, WorkspaceRole } from '@orvex-review/store';
import type { PlanFeatures, PlanId } from './plans.js';

/** Named privileges for code acting on a tenant on behalf of a user. */
export type TenantCapability = 'workspace:read' | 'workspace:connect';

/** Product capabilities are independent of display labels and plan IDs. */
export type PlanCapability =
  | 'review:autofix'
  | 'review:deep'
  | 'review:runtime-verify'
  | 'review:strict-verify'
  | 'review:nightly-scan'
  | 'review:repository-sweep';

export const TENANT_OWNER_ROLE: WorkspaceRole = 'owner';
const CUSTOM_CONTRACT_PLANS: ReadonlySet<PlanId> = new Set<PlanId>(['enterprise']);

export function hasTenantCapability(
  membership: WorkspaceMember | null | undefined,
  capability: TenantCapability,
): boolean {
  switch (capability) {
    case 'workspace:read':
    case 'workspace:connect':
      return membership !== null && membership !== undefined;
  }
}

/** A membership always wins over the claimable pre-auth workspace state. */
export function mayClaimWorkspace(
  membership: WorkspaceMember | null | undefined,
  isClaimable: boolean,
): boolean {
  return !membership && isClaimable;
}

export function hasPlanCapability(plan: PlanFeatures, capability: PlanCapability): boolean {
  switch (capability) {
    case 'review:autofix':
      return plan.autofix;
    case 'review:deep':
      return plan.deepReviews;
    case 'review:runtime-verify':
      return plan.codeExecution;
    case 'review:strict-verify':
      return plan.deepVerify;
    case 'review:nightly-scan':
      return plan.nightlyScans;
    case 'review:repository-sweep':
      return plan.repoSweep;
  }
}

export function isCustomContractPlan(plan: PlanFeatures): boolean {
  return CUSTOM_CONTRACT_PLANS.has(plan.id);
}

export interface ReviewEntitlement {
  readonly modelTier: PlanFeatures['modelTier'];
  readonly discoveryPasses: number;
  readonly retrievalTopK: number;
  readonly queuePriority: number;
}

export function reviewEntitlement(plan: PlanFeatures): ReviewEntitlement {
  return Object.freeze({
    modelTier: plan.modelTier,
    discoveryPasses: plan.reviewPasses,
    retrievalTopK: plan.retrievalTopK,
    queuePriority: plan.priority,
  });
}
