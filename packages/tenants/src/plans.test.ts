import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planFeatures, PLANS, isPlanId } from './plans.js';

test('Review runs the SAME review pipeline as Verify — the tier differs by MODEL', () => {
  // Product decision: Review isn't a crippled Verify — it's the same 2-pass
  // deep-dive + deep retrieval, run on the cheaper 'standard' model (MiniMax,
  // ~4x cheaper). Verify uses the flagship model + adds code execution.
  assert.equal(planFeatures('review').reviewPasses, planFeatures('verify').reviewPasses);
  assert.equal(planFeatures('review').retrievalTopK, planFeatures('verify').retrievalTopK);
  assert.equal(planFeatures('review').modelTier, 'standard', 'Review runs MiniMax (cheap)');
  assert.equal(planFeatures('free').modelTier, 'standard');
  // Higher tiers run the two-model ensemble (MiniMax pass 1 + GLM pass 2).
  assert.equal(planFeatures('verify').modelTier, 'hybrid');
  assert.equal(planFeatures('enterprise').modelTier, 'hybrid');
  // both paid review tiers still do the 2-pass deep-dive (not a 28-call sweep)
  assert.equal(planFeatures('verify').reviewPasses, 2);
});

test('code execution + nightly scans remain the Verify/Enterprise premium (Review does not get them)', () => {
  assert.equal(planFeatures('review').codeExecution, false);
  assert.equal(planFeatures('verify').codeExecution, true);
  assert.equal(planFeatures('review').nightlyScans, false);
  assert.equal(planFeatures('verify').nightlyScans, true);
});

test('the expensive whole-repo sweep is OFF on every tier (it cost more and reviewed worse)', () => {
  assert.equal(planFeatures('free').repoSweep, false);
  assert.equal(planFeatures('review').repoSweep, false);
  assert.equal(planFeatures('verify').repoSweep, false);
  assert.equal(planFeatures('enterprise').repoSweep, false);
});

test('committing fixes requires a paid tier', () => {
  assert.equal(planFeatures('free').autofix, false);
  assert.equal(planFeatures('review').autofix, true);
  assert.equal(planFeatures('verify').autofix, true);
});

test('code execution (TREX equivalent) is gated to Verify and Enterprise', () => {
  assert.equal(planFeatures('free').codeExecution, false);
  assert.equal(planFeatures('review').codeExecution, false);
  assert.equal(planFeatures('verify').codeExecution, true);
  assert.equal(planFeatures('enterprise').codeExecution, true);
});

test('nightly scans track the same gate as code execution', () => {
  assert.equal(planFeatures('review').nightlyScans, false);
  assert.equal(planFeatures('verify').nightlyScans, true);
});

test('free tier is a lifetime trial; paid tiers have no lifetime cap', () => {
  assert.equal(planFeatures('free').trialReviewLimit, 10);
  assert.equal(planFeatures('review').trialReviewLimit, null);
  assert.equal(planFeatures('verify').trialReviewLimit, null);
});

test('every tier has an hourly SAFETY ceiling except enterprise (custom contract) — no tier is truly unlimited by accident', () => {
  // Real incident: paid tiers were `reviewsPerHour: null` (zero ceiling), and a
  // day of restart-loop testing on a Verify account burned ~4M reasoning tokens
  // with nothing to catch it. Every self-serve tier now has a generous-but-real
  // cap so a bug/misconfig/runaway-testing session can't silently exhaust the
  // shared provider budget.
  assert.equal(planFeatures('free').reviewsPerHour, 2);
  assert.ok(planFeatures('review').reviewsPerHour !== null, 'review must have a real ceiling');
  assert.ok(planFeatures('verify').reviewsPerHour !== null, 'verify must have a real ceiling');
  // Verify now costs about the same per review as Review (both a single focused
  // pass), so its ceiling no longer needs to be lower — same generous cap is fine.
  assert.ok(planFeatures('verify').reviewsPerHour! >= planFeatures('review').reviewsPerHour!);
});

test('paid tiers now have a real MONTHLY cost-exposure ceiling too, not just hourly burst protection', () => {
  // Real gap the user identified: reviewsPerHour alone bounds a fast burst, but
  // nothing stopped a heavy account from running near that ceiling continuously,
  // 24/7, for a month, costing far more than a flat subscription covers.
  assert.ok(planFeatures('review').reviewsPerMonth !== null, 'review must have a monthly ceiling');
  assert.ok(planFeatures('verify').reviewsPerMonth !== null, 'verify must have a monthly ceiling');
  // Verify now costs ~the same per review as Review (single focused pass), so a
  // matching monthly ceiling is fine — no need to cap it lower.
  assert.ok(planFeatures('verify').reviewsPerMonth! >= planFeatures('review').reviewsPerMonth!);
  // The ceiling must be well above realistic daily usage (sanity: >100/mo) so it
  // never fires for a real team — it's tail-risk insurance, not a UX constraint.
  assert.ok(planFeatures('review').reviewsPerMonth! > 100);
  assert.ok(planFeatures('verify').reviewsPerMonth! > 100);
});

test('unknown / null plan resolves to a safe default (never grants execution)', () => {
  assert.equal(planFeatures(null).codeExecution, false);
  assert.equal(planFeatures(undefined).codeExecution, false);
  assert.equal(planFeatures('bogus').codeExecution, false);
});

test('isPlanId guards billing input', () => {
  assert.ok(isPlanId('verify'));
  assert.ok(!isPlanId('platinum'));
});

test('priority increases with tier (queue fairness)', () => {
  assert.ok(PLANS.verify.priority > PLANS.review.priority);
  assert.ok(PLANS.enterprise.priority > PLANS.verify.priority);
});
