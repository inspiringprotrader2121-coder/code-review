import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planFeatures, PLANS, isPlanId, defaultPlanId } from './plans.js';

test('model tiers: volume plans use the dual-model track; Verify plans and Enterprise use multi-model', () => {
  assert.equal(planFeatures('free').modelTier, 'dual-model');
  assert.equal(planFeatures('review').modelTier, 'dual-model');
  assert.equal(planFeatures('review-plus').modelTier, 'dual-model');
  assert.equal(planFeatures('verify-lite').modelTier, 'multi-model');
  assert.equal(planFeatures('verify').modelTier, 'multi-model');
  assert.equal(planFeatures('enterprise').modelTier, 'multi-model');
});

test('each plan uses its configured pass count with shared retrieval and strict verification', () => {
  for (const p of ['free', 'review', 'review-plus', 'verify-lite', 'verify', 'enterprise'] as const) {
    const expected = planFeatures(p).modelTier === 'multi-model' ? 4 : 3;
    assert.equal(planFeatures(p).reviewPasses, expected, `${p} runs its full pipeline`);
    assert.equal(planFeatures(p).retrievalTopK, 28, `${p} gets the same retrieval depth`);
    assert.equal(planFeatures(p).deepVerify, true, `${p} gets the strict verification`);
  }
  assert.equal(planFeatures('verify').modelTier, 'multi-model');
  assert.equal(planFeatures('review').modelTier, 'dual-model');
});

test('every plan shares autofix and runtime-verification capability', () => {
  for (const p of ['free', 'review', 'review-plus', 'verify-lite', 'verify', 'enterprise'] as const) {
    assert.equal(planFeatures(p).autofix, true, `${p} gets autofix`);
    assert.equal(planFeatures(p).codeExecution, true, `${p} gets sandbox code execution`);
  }
});

test('@orvex deep is paid-only (2x review cost — unbounded on a free account)', () => {
  assert.equal(planFeatures('free').deepReviews, false);
  assert.equal(planFeatures('review').deepReviews, true);
  assert.equal(planFeatures('review-plus').deepReviews, true);
  assert.equal(planFeatures('verify-lite').deepReviews, true);
  assert.equal(planFeatures('verify').deepReviews, true);
  assert.equal(planFeatures('enterprise').deepReviews, true);
});

test('nightly scans are the ONE deliberate exception: paid tiers only, never the unpaid free trial', () => {
  // Unlike every other feature, scheduled scans are NOT counted against
  // trialReviewLimit or any other cap — an unbounded daily job per repo,
  // forever. Enabling that for an unpaid account would be a real cost bug.
  assert.equal(planFeatures('free').nightlyScans, false, 'free trial excluded — unbounded-cost risk');
  assert.equal(planFeatures('review').nightlyScans, true);
  assert.equal(planFeatures('review-plus').nightlyScans, true);
  assert.equal(planFeatures('verify-lite').nightlyScans, true);
  assert.equal(planFeatures('verify').nightlyScans, true);
  assert.equal(planFeatures('enterprise').nightlyScans, true);
});

test('the expensive whole-repo sweep is OFF on every tier (it cost more and reviewed worse)', () => {
  assert.equal(planFeatures('free').repoSweep, false);
  assert.equal(planFeatures('review').repoSweep, false);
  assert.equal(planFeatures('review-plus').repoSweep, false);
  assert.equal(planFeatures('verify-lite').repoSweep, false);
  assert.equal(planFeatures('verify').repoSweep, false);
  assert.equal(planFeatures('enterprise').repoSweep, false);
});

test('free tier is a lifetime trial; paid tiers have no lifetime cap', () => {
  assert.equal(planFeatures('free').trialReviewLimit, 10);
  assert.equal(planFeatures('review').trialReviewLimit, null);
  assert.equal(planFeatures('verify').trialReviewLimit, null);
});

test('pricing structure: Starter $29 (100/mo @ 5/hr, $0.50 overage) < Pro Unlimited $69 (∞ @ 10/hr); Verify Lite $49 (50/mo) < Verify $99 (120/mo), both $0.75 overage', () => {
  // Two tracks: volume (dual-model) — Free < Starter < Pro Unlimited; and
  // quality (multi-model) — Verify Lite < Verify. Verify tiers are quota-capped.
  assert.equal(planFeatures('review').reviewsPerHour, 5);
  assert.equal(planFeatures('review').reviewsPerMonth, 100);
  assert.equal(planFeatures('review').includedReviewsPerMonth, 100);
  assert.equal(planFeatures('review').overageCentsPerReview, 50);
  assert.equal(planFeatures('review-plus').reviewsPerHour, 10);
  assert.equal(planFeatures('review-plus').reviewsPerMonth, null, 'unlimited — the hourly cap is the abuse defense');
  assert.equal(planFeatures('review-plus').includedReviewsPerMonth, null);
  assert.equal(planFeatures('review-plus').overageCentsPerReview, null);
  // Verify Lite: budget entry to the multi-model track.
  assert.equal(planFeatures('verify-lite').modelTier, 'multi-model', 'same review track as Verify');
  assert.equal(planFeatures('verify-lite').reviewsPerHour, 5);
  assert.equal(planFeatures('verify-lite').reviewsPerMonth, 50);
  assert.equal(planFeatures('verify-lite').includedReviewsPerMonth, 50);
  assert.equal(planFeatures('verify-lite').overageCentsPerReview, 75);
  assert.equal(planFeatures('verify').reviewsPerHour, 10);
  assert.equal(planFeatures('verify').reviewsPerMonth, 120);
  assert.equal(planFeatures('verify').includedReviewsPerMonth, 120);
  assert.equal(planFeatures('verify').overageCentsPerReview, 75);
  // Verify tiers are quota-capped, never unlimited (Luna cost defense).
  assert.notEqual(planFeatures('verify-lite').reviewsPerMonth, null);
  assert.notEqual(planFeatures('verify').reviewsPerMonth, null);
  // Free trial keeps its tight burst cap.
  assert.equal(planFeatures('free').reviewsPerHour, 2);
});

test('Verify Lite is the SAME product as Verify — same models/thoroughness, smaller quota only', () => {
  const lite = planFeatures('verify-lite');
  const verify = planFeatures('verify');
  assert.equal(lite.modelTier, verify.modelTier, 'identical multi-model review track');
  assert.equal(lite.reviewPasses, verify.reviewPasses);
  assert.equal(lite.deepVerify, verify.deepVerify);
  assert.equal(lite.deepReviews, verify.deepReviews);
  assert.equal(lite.codeExecution, verify.codeExecution);
  assert.equal(lite.nightlyScans, verify.nightlyScans);
  // Differs ONLY by volume/price levers.
  assert.ok(lite.includedReviewsPerMonth! < verify.includedReviewsPerMonth!);
  assert.ok(lite.reviewsPerHour! < verify.reviewsPerHour!);
});

test('review-plus is the same PANEL product as review — more volume, not more depth', () => {
  const review = planFeatures('review');
  const plus = planFeatures('review-plus');
  assert.equal(plus.modelTier, review.modelTier);
  assert.equal(plus.reviewPasses, review.reviewPasses);
  assert.equal(plus.deepVerify, review.deepVerify);
  assert.equal(plus.autofix, review.autofix);
  assert.equal(plus.codeExecution, review.codeExecution);
  assert.equal(plus.nightlyScans, review.nightlyScans);
});

test('unknown / null plan resolves to the bounded free tier, never the unbounded nightly-scan feature', () => {
  // Free legitimately gets execution/autofix now (same thoroughness as every
  // tier), so an unknown plan resolving to free is fine — it's still capped by
  // trialReviewLimit/reviewsPerHour. The property that actually matters: an
  // unrecognized plan string must never grant the ONE unbounded-cost feature.
  for (const bad of [null, undefined, 'bogus'] as const) {
    assert.equal(planFeatures(bad).nightlyScans, false, 'never the uncapped feature');
    assert.equal(planFeatures(bad).trialReviewLimit, 10, 'resolves to the bounded free tier');
  }
});

test('isPlanId guards billing input', () => {
  assert.ok(isPlanId('verify'));
  assert.ok(!isPlanId('platinum'));
});

test('priority increases with tier (queue fairness)', () => {
  assert.ok(PLANS.verify.priority > PLANS.review.priority);
  assert.ok(PLANS.enterprise.priority > PLANS.verify.priority);
  assert.ok(PLANS['verify-lite'].priority >= PLANS.review.priority, 'premium track prioritized over entry dual-model');
});

test('prototype keys are NOT plans (Object.hasOwn, not `in`)', () => {
  for (const bad of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
    assert.equal(planFeatures(bad).id, 'free', `${bad} must fall through to the free plan`);
  }
  const prev = process.env.ORVEX_DEFAULT_PLAN;
  process.env.ORVEX_DEFAULT_PLAN = 'constructor';
  try {
    assert.equal(defaultPlanId(), 'free');
  } finally {
    if (prev === undefined) delete process.env.ORVEX_DEFAULT_PLAN;
    else process.env.ORVEX_DEFAULT_PLAN = prev;
  }
});
