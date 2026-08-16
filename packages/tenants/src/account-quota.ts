import { loadTenantRuntimeConfig, type TenantRuntimeConfig } from './config.js';
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
  const value = email?.trim().toLowerCase();
  return Boolean(value && emailsFrom(config).has(value));
}

export function isUnlimitedTenantSlug(
  slug: string | null | undefined,
  config: TenantRuntimeConfig = loadTenantRuntimeConfig(),
): boolean {
  const value = slug?.trim().toLowerCase();
  return Boolean(value && slugsFrom(config).has(value));
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
): PlanFeatures {
  const features = planFeatures(plan, config);
  return isUnlimitedGithubOwner(owner, config) ? uncapPlan(features) : features;
}

export function reviewJobAdmissionFields(
  owner: string,
  planId: string | null | undefined,
  config: TenantRuntimeConfig = loadTenantRuntimeConfig(),
): { priority: number; quotaUnlimited: boolean } {
  const plan = planFeaturesForAccount(planId, owner, config);
  return {
    priority: plan.priority,
    quotaUnlimited: isUnlimitedGithubOwner(owner, config),
  };
}
