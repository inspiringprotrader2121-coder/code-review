import { loadTenantRuntimeConfig, type TenantRuntimeConfig } from './config.js';
import { normalizeEmail } from './email-identity.js';
import { planFeatures, type PlanFeatures } from './plans.js';

function ownersFrom(config: TenantRuntimeConfig): ReadonlySet<string> {
  return new Set(config.unlimitedGithubOwners);
}

function emailsFrom(config: TenantRuntimeConfig): ReadonlySet<string> {
  return new Set(config.unlimitedAccountEmails);
}

function slugsFrom(config: TenantRuntimeConfig): ReadonlySet<string> {
  return new Set(config.unlimitedTenantSlugs);
}

export function isUnlimitedGithubOwner(
  owner: string | null | undefined,
  config: TenantRuntimeConfig = loadTenantRuntimeConfig(),
): boolean {
  const login = owner?.trim().toLowerCase();
  return Boolean(login && ownersFrom(config).has(login));
}

export function isUnlimitedAccountEmail(
  email: string | null | undefined,
  config: TenantRuntimeConfig = loadTenantRuntimeConfig(),
): boolean {
  const value = email?.trim();
  if (!value) return false;
  const normalized = normalizeEmail(value);
  for (const allowed of emailsFrom(config)) {
    if (normalizeEmail(allowed) === normalized) return true;
  }
  return false;
}

export function isUnlimitedTenantSlug(
  slug: string | null | undefined,
  config: TenantRuntimeConfig = loadTenantRuntimeConfig(),
): boolean {
  const value = slug?.trim().toLowerCase();
  return Boolean(value && slugsFrom(config).has(value));
}

export interface OperatorIdentity {
  owner?: string | null;
  email?: string | null;
  slug?: string | null;
}

/** True when any operator allowlist identity matches. */
export function isUnlimitedOperator(
  identity: OperatorIdentity,
  config: TenantRuntimeConfig = loadTenantRuntimeConfig(),
): boolean {
  return (
    isUnlimitedGithubOwner(identity.owner, config) ||
    isUnlimitedAccountEmail(identity.email, config) ||
    isUnlimitedTenantSlug(identity.slug, config)
  );
}

/** Strip every numeric quota so an operator account is not plan-gated. */
export function uncapPlan(plan: PlanFeatures): PlanFeatures {
  return {
    ...plan,
    trialReviewLimit: null,
    reviewsPerHour: null,
    maxConcurrentReviews: null,
    reviewsPerMonth: null,
    includedReviewsPerMonth: null,
    overageCentsPerReview: null,
  };
}

export function planFeaturesForAccount(
  plan: string | null | undefined,
  owner: string | null | undefined,
  config: TenantRuntimeConfig = loadTenantRuntimeConfig(),
  identity: Omit<OperatorIdentity, 'owner'> = {},
): PlanFeatures {
  const features = planFeatures(plan, config);
  return isUnlimitedOperator({ owner, email: identity.email, slug: identity.slug }, config)
    ? uncapPlan(features)
    : features;
}

export function reviewJobAdmissionFields(
  owner: string,
  planId: string | null | undefined,
  config: TenantRuntimeConfig = loadTenantRuntimeConfig(),
  identity: Omit<OperatorIdentity, 'owner'> = {},
): { priority: number; quotaUnlimited: boolean } {
  const plan = planFeaturesForAccount(planId, owner, config, identity);
  return {
    priority: plan.priority,
    // Redis tenant-claim Lua skips the fleet tenant ceiling for these jobs.
    quotaUnlimited: isUnlimitedOperator({ owner, ...identity }, config),
  };
}
