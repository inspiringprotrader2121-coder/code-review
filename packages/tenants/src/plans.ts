/**
 * Subscription plans and the feature matrix they gate.
 *
 * Tiering strategy (see product decision): the deep, index-powered review is in
 * EVERY paid tier — that's what makes the lower tier worth buying, not a crippled
 * teaser. The premium tier ("Verify") is separated by *execution and scale*:
 * running the change in a sandbox (the TREX equivalent), nightly whole-repo
 * scans, and higher limits. Billing is plan-primary; the expensive execution
 * runs are the natural place to meter/credit overage.
 */
import { loadTenantRuntimeConfig, type TenantRuntimeConfig } from './config.js';
import { hasPlanCapability, isCustomContractPlan } from './policy.js';

export type PlanId = 'free' | 'review' | 'review-plus' | 'verify-lite' | 'verify' | 'enterprise';

export interface PlanFeatures {
  id: PlanId;
  label: string;
  /** Published monthly subscription price in cents for operator unit economics. */
  monthlyPriceCents?: number;
  /** number of deep review passes over the diff + neighborhood */
  reviewPasses: number;
  /** how many index-retrieved relevant files feed the review passes (cross-file depth) */
  retrievalTopK: number;
  /** Legacy sweep switch. Disabled for every current plan. */
  repoSweep: boolean;
  /** Legacy sweep file cap (only when repoSweep). */
  sweepMaxFiles: number;
  /** may commit fixes (`@orvex fix`, apply-fix checkbox) — paid tiers only */
  autofix: boolean;
  /** `@orvex deep` — extra diverse passes unioned into one review. Paid only:
   *  it's ~2x a normal review's cost, the exact thing a free trial's lifetime
   *  cap exists to bound. */
  deepReviews: boolean;
  /** Tier 2: run the change in a sandbox, run tests, attach runtime evidence */
  codeExecution: boolean;
  /** Tier 2: scheduled whole-repo bug scans that open fix PRs */
  nightlyScans: boolean;
  /**
   * When true, run the end-of-review LLM verification (strict premise check with
   * package.json / manifest context). When false, skip that LLM call entirely —
   * used on the dual-model (free/Starter/Pro) track to keep cost at two discovery
   * passes. Deterministic filters / noise drops still run either way.
   */
  deepVerify: boolean;
  /**
   * LIFETIME free reviews for the GitHub account (null = unlimited). This is a
   * trial cap, not a monthly reset — it's counted per GitHub account (repo owner),
   * so making a second workspace or reinstalling the App does NOT reset it.
   */
  trialReviewLimit: number | null;
  /** max reviews per rolling hour for the account (null = unlimited) */
  reviewsPerHour: number | null;
  /**
   * Max in-flight reviews for this account at once (null = unlimited besides the
   * worker's global ORVEX_MAX_CONCURRENT_REVIEWS). Prevents a single push storm
   * from burning the entire hourly bucket in parallel — especially costly when
   * reviews fail after LLM spend.
   */
  maxConcurrentReviews: number | null;
  /**
   * Max reviews per rolling 30 days for the account (null = unlimited). Unlike
   * reviewsPerHour (burst/abuse protection), this bounds total MONTHLY cost
   * exposure — the gap that let one account run unlimited reviews all month on
   * a flat subscription with no ceiling on total spend. Sized as tail-risk
   * insurance (a real team should never come close), not a real-world limit —
   * see the reasoning in PLANS below. Adjust via the plan-admin endpoint once
   * real subscription prices are set; these are reasoned defaults, not
   * confirmed business numbers.
   */
  reviewsPerMonth: number | null;
  /**
   * Included reviews per Stripe billing period before overage is billed. For
   * METERED plans (overageCentsPerReview != null) this is the ONLY quota that
   * matters: reviewsPerMonth's hard block is deliberately skipped and usage
   * above this line is reserved from the prepaid wallet. For NON-metered plans reviewsPerMonth is the
   * hard ceiling instead.
   */
  includedReviewsPerMonth: number | null;
  /** Overage charge, in USD cents, per completed review above the included quota. */
  overageCentsPerReview: number | null;
  /**
   * Which LLM(s) run the review:
   * - 'dual-model' — MiniMax (general) + DeepSeek v4 Flash (deep-dive); Flash verify.
   *   Free / Starter / Pro. Two discovery passes.
   * - 'multi-model' — Luna/Codex + combined Flash deep-dive + MiniMax; Flash verify.
   *   Verify Lite / Verify / Enterprise. Three discovery passes.
   * - 'codex-hybrid' — Codex/Luna general, MiniMax thereafter (legacy hybrid).
   * - 'standard' — MiniMax on every pass. 'premium' — GLM on every pass.
   * - 'hybrid' / 'openai' — legacy single-provider ensembles.
   */
  modelTier:
    | 'premium'
    | 'standard'
    | 'hybrid'
    | 'openai'
    | 'codex-hybrid'
    | 'multi-model'
    | 'dual-model';
  /** queue priority when workers are saturated (higher = sooner) */
  priority: number;
}

/**
 * Cost model. Entry plans run two focused discovery stages; higher tiers run
 * three. A separate Flash verifier checks the merged candidates. Optional deep,
 * aggregation, investigate, and risk-hunt work is excluded unless explicitly
 * enabled. Hard per-review/provider caps prevent runaway calls.
 *
 * The per-hour/month numbers below are generous SAFETY ceilings (runaway
 * protection), not usage targets — a real team never approaches them. Adjust
 * live via the plan-admin endpoint; set ORVEX_COST_INPUT_PER_M /
 * ORVEX_COST_OUTPUT_PER_M to the provider's real per-token rates for accurate
 * spend tracking.
 */
export const PLANS: Record<PlanId, PlanFeatures> = {
  // PRODUCT RULE (user decision 2026-08-05): review thoroughness (retrieval,
  // autofix, execution) stays consistent; what changes by tier is HOW MANY
  // models/passes run:
  //   dual-model (free / Starter / Pro) → TWO discovery passes + Flash verify:
  //     MiniMax (general) + DeepSeek v4 Flash (deep-dive) + Flash verify.
  //     No investigate — cost-bounded trial/entry track.
  //   multi-model (Verify Lite / Verify / Enterprise) → three discovery passes
  //     (Luna/Codex + combined Flash + MiniMax) + Flash verify. Diagnostic bonus
  //     passes are opt-in and are not part of the normal plan contract.
  //
  // ONE deliberate exception: nightlyScans. Unlike every other feature here,
  // scheduled whole-repo scans are NOT counted against trialReviewLimit or any
  // other cap — it's an unbounded daily job per eligible repo, forever. Turning
  // that on for the UNPAID free trial would be a real uncapped-cost bug, not a
  // feature, so it stays paid-tier-only until nightly scans get their own cap.
  free: {
    id: 'free',
    label: 'Free trial',
    monthlyPriceCents: 0,
    reviewPasses: 2,
    retrievalTopK: 28,
    repoSweep: false,
    sweepMaxFiles: 0,
    autofix: true,
    deepReviews: false, // paid-only: ~2x review cost, bounded nowhere on a free account
    codeExecution: true,
    nightlyScans: false, // see the unbounded-cost note above — free stays excluded
    deepVerify: true, // Flash verify — cheap precision gate on the 2-model track
    trialReviewLimit: 10, // 10 free reviews for the account, ever — bounds autofix/execution cost too
    reviewsPerHour: 2,
    maxConcurrentReviews: 1,
    reviewsPerMonth: null, // the lifetime cap already bounds free-tier cost; no separate monthly needed
    includedReviewsPerMonth: null,
    overageCentsPerReview: null,
    modelTier: 'dual-model', // MiniMax + DeepSeek v4 Flash + Flash verify
    priority: 0,
  },
  review: {
    id: 'review',
    label: 'Starter', // MiniMax + DeepSeek v4 Flash — the entry paid tier
    monthlyPriceCents: 2900,
    // $29/mo — 100 reviews included, then prepaid overage at $0.50/review up to
    // a 1000/mo hard safety ceiling. Overage requires wallet balance first.
    reviewPasses: 2,
    retrievalTopK: 28,
    repoSweep: false,
    sweepMaxFiles: 0,
    autofix: true,
    deepReviews: true,
    codeExecution: true,
    nightlyScans: true,
    deepVerify: true,
    trialReviewLimit: null,
    reviewsPerHour: 5,
    maxConcurrentReviews: 2,
    reviewsPerMonth: 1000, // hard safety ceiling; included 100, then prepaid overage
    includedReviewsPerMonth: 100,
    overageCentsPerReview: 50,
    modelTier: 'dual-model',
    priority: 1,
  },
  'review-plus': {
    id: 'review-plus',
    label: 'Pro',
    monthlyPriceCents: 6900,
    // $69/mo — 500 reviews/month HARD total at 10/hour. Same MiniMax + Flash
    // two-pass as Starter; more volume, not more models. Not unlimited.
    reviewPasses: 2,
    retrievalTopK: 28,
    repoSweep: false,
    sweepMaxFiles: 0,
    autofix: true,
    deepReviews: true,
    codeExecution: true,
    nightlyScans: true,
    deepVerify: true,
    trialReviewLimit: null,
    reviewsPerHour: 10,
    maxConcurrentReviews: 3,
    reviewsPerMonth: 500,
    includedReviewsPerMonth: 500,
    overageCentsPerReview: null,
    modelTier: 'dual-model',
    priority: 1,
  },
  'verify-lite': {
    id: 'verify-lite',
    label: 'Verify Lite',
    monthlyPriceCents: 4900,
    // $49/mo — 50 reviews included, then prepaid overage at $0.75/review up to
    // a 500/mo hard safety ceiling on the multi-model track.
    reviewPasses: 3,
    retrievalTopK: 28,
    repoSweep: false,
    sweepMaxFiles: 0,
    autofix: true,
    deepReviews: true,
    codeExecution: true,
    nightlyScans: true,
    deepVerify: true,
    trialReviewLimit: null,
    reviewsPerHour: 5,
    maxConcurrentReviews: 2,
    reviewsPerMonth: 500,
    includedReviewsPerMonth: 50,
    overageCentsPerReview: 75,
    modelTier: 'multi-model',
    priority: 2,
  },
  verify: {
    id: 'verify',
    label: 'Verify',
    monthlyPriceCents: 9900,
    // multi-model full track (four required model stages) on EVERY PR:
    //   pass 1 — Luna / Codex CLI (general)
    //   pass 2 — DeepSeek v4 Flash (deep-dive + removed-behavior/callers)
    //   pass 3 — MiniMax (perf / completeness / API-contract)
    //   then ONE strict verification on DeepSeek v4 Flash (when candidates exist)
    // $99/mo — 120 reviews included, then prepaid overage at $1.50/review up to
    // a 1000/mo hard safety ceiling at 10/hour.
    reviewPasses: 3,
    retrievalTopK: 28,
    repoSweep: false,
    sweepMaxFiles: 0,
    autofix: true,
    deepReviews: true,
    codeExecution: true,
    nightlyScans: true,
    deepVerify: true,
    trialReviewLimit: null,
    reviewsPerHour: 10,
    maxConcurrentReviews: 3,
    reviewsPerMonth: 1000,
    includedReviewsPerMonth: 120,
    overageCentsPerReview: 150,
    modelTier: 'multi-model',
    priority: 3,
  },
  enterprise: {
    id: 'enterprise',
    label: 'Enterprise',
    reviewPasses: 3,
    retrievalTopK: 28,
    repoSweep: false,
    sweepMaxFiles: 0,
    autofix: true,
    deepReviews: true,
    codeExecution: true,
    nightlyScans: true,
    deepVerify: true,
    trialReviewLimit: null,
    // Safety defaults for the custom-contract tier — raise per customer via
    // plan-admin; never ship a null monthly/hourly path that can burn uncapped.
    reviewsPerHour: 50,
    maxConcurrentReviews: 8,
    reviewsPerMonth: 2000,
    includedReviewsPerMonth: 2000,
    overageCentsPerReview: null,
    modelTier: 'multi-model',
    priority: 4,
  },
};

/** Plan for a tenant with no explicit plan set — the free trial, so an unknown
 *  or brand-new account never falls through to paid features. Env-overridable. */
export function defaultPlanId(config: TenantRuntimeConfig = loadTenantRuntimeConfig()): PlanId {
  const configuredPlan = config.defaultPlanId;
  // Object.hasOwn, not `in`: 'constructor' in PLANS is TRUE via the prototype
  // chain and would return Object as a "plan".
  return configuredPlan && Object.hasOwn(PLANS, configuredPlan)
    ? (configuredPlan as PlanId)
    : 'free';
}

/** Resolve a stored plan string (possibly null/unknown) to its feature set. */
export function planFeatures(
  plan: string | null | undefined,
  config: TenantRuntimeConfig = loadTenantRuntimeConfig(),
): PlanFeatures {
  if (plan && Object.hasOwn(PLANS, plan)) return PLANS[plan as PlanId];
  return PLANS[defaultPlanId(config)];
}

/** Label safe for customer-facing dashboard and quota messages. */
export function publicPlanLabel(plan: PlanFeatures): string {
  return isCustomContractPlan(plan) ? 'Custom plan' : plan.label;
}

/** Named entitlement helpers keep callers out of raw plan feature branches. */
export const canAutofix = (plan: PlanFeatures): boolean =>
  hasPlanCapability(plan, 'review:autofix');
export const canRunDeepReview = (plan: PlanFeatures): boolean =>
  hasPlanCapability(plan, 'review:deep');
export const canRunCodeExecution = (plan: PlanFeatures): boolean =>
  hasPlanCapability(plan, 'review:runtime-verify');
export const canRunNightlyScans = (plan: PlanFeatures): boolean =>
  hasPlanCapability(plan, 'review:nightly-scan');

export function isPlanId(v: string): v is PlanId {
  // Object.hasOwn, not `in`: `'constructor' in PLANS` (and other prototype keys)
  // is true and would pass user-supplied plan strings through to planFeatures.
  return Object.hasOwn(PLANS, v);
}
