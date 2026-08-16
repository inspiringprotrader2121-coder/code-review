import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTenantRuntimeConfig } from './config.js';
import {
  isUnlimitedAccountEmail,
  isUnlimitedGithubOwner,
  isUnlimitedOperator,
  isUnlimitedTenantSlug,
  planFeaturesForAccount,
  reviewJobAdmissionFields,
  uncapPlan,
} from './account-quota.js';
import { planFeatures } from './plans.js';

const config = loadTenantRuntimeConfig({
  ORVEX_UNLIMITED_GITHUB_OWNERS: 'inspiringprotrader2121-coder, Other-Org ',
  ORVEX_UNLIMITED_ACCOUNT_EMAILS: 'inspiringprotrader2121@gmail.com',
  ORVEX_UNLIMITED_TENANT_SLUGS: 'org-inspiringprotrader2121-coder,inspiringprotrader2121-coder',
});

test('operator allowlists match github owner, email, and tenant slug', () => {
  assert.equal(isUnlimitedGithubOwner('inspiringprotrader2121-coder', config), true);
  assert.equal(isUnlimitedGithubOwner('OTHER-ORG', config), true);
  assert.equal(isUnlimitedGithubOwner('someone-else', config), false);
  assert.equal(isUnlimitedAccountEmail('inspiringprotrader2121@gmail.com', config), true);
  assert.equal(isUnlimitedAccountEmail('inspiring.protrader2121+ops@gmail.com', config), true);
  assert.equal(isUnlimitedAccountEmail('other@example.com', config), false);
  assert.equal(isUnlimitedTenantSlug('org-inspiringprotrader2121-coder', config), true);
  assert.equal(isUnlimitedOperator({ email: 'inspiringprotrader2121@gmail.com' }, config), true);
  assert.equal(isUnlimitedOperator({ slug: 'inspiringprotrader2121-coder' }, config), true);
  assert.equal(isUnlimitedOperator({ owner: 'acme', email: 'other@example.com' }, config), false);
});

test('uncapping a custom plan removes every numeric quota', () => {
  const capped = planFeatures('enterprise');
  assert.equal(capped.maxConcurrentReviews, 8);
  const open = uncapPlan(capped);
  assert.equal(open.maxConcurrentReviews, null);
  assert.equal(open.reviewsPerHour, null);
  assert.equal(open.reviewsPerMonth, null);
  assert.equal(open.includedReviewsPerMonth, null);
  assert.equal(open.trialReviewLimit, null);
  assert.equal(open.overageCentsPerReview, null);
  assert.equal(open.modelTier, 'multi-model');
  assert.equal(open.reviewPasses, 3);
});

test('review enqueue fields mark the operator owner as quota-unlimited', () => {
  const fields = reviewJobAdmissionFields('inspiringprotrader2121-coder', 'enterprise', config);
  assert.equal(fields.quotaUnlimited, true);
  assert.equal(fields.priority, planFeatures('enterprise').priority);
  const other = reviewJobAdmissionFields('acme', 'enterprise', config);
  assert.equal(other.quotaUnlimited, false);
  assert.equal(planFeaturesForAccount('enterprise', 'acme', config).maxConcurrentReviews, 8);
});

test('operator github owner and email stay uncapped at the plan overlay', () => {
  const byOwner = planFeaturesForAccount('verify', 'inspiringprotrader2121-coder', config);
  assert.equal(byOwner.maxConcurrentReviews, null);
  assert.equal(byOwner.reviewsPerHour, null);
  assert.equal(byOwner.reviewsPerMonth, null);
  assert.equal(byOwner.trialReviewLimit, null);
  assert.equal(byOwner.overageCentsPerReview, null);
  assert.equal(byOwner.modelTier, 'multi-model');

  const byEmail = planFeaturesForAccount('review', 'acme', config, {
    email: 'inspiringprotrader2121@gmail.com',
  });
  assert.equal(byEmail.maxConcurrentReviews, null);
  assert.equal(byEmail.reviewsPerHour, null);

  const bySlug = planFeaturesForAccount('review-plus', 'acme', config, {
    slug: 'org-inspiringprotrader2121-coder',
  });
  assert.equal(bySlug.maxConcurrentReviews, null);

  const paid = planFeaturesForAccount('verify', 'acme', config);
  assert.equal(paid.maxConcurrentReviews, 5);
  assert.equal(paid.reviewsPerHour, 10);
});
