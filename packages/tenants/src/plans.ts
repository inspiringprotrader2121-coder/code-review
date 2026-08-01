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

export type PlanId = 'free' | 'review' | 'review-plus' | 'verify-lite' | 'verify' | 'enterprise';

export interface PlanFeatures {
  id: PlanId;
  label: string;
  /** number of deep review passes over the diff + neighborhood */
  reviewPasses: number;
  /** how many index-retrieved relevant files feed the review passes (cross-file depth) */
  retrievalTopK: number;
  /** Tier 2: exhaustive whole-repo sweep in batches beyond the top-K */
  repoSweep: boolean;
  /** extra repo files the sweep covers (only when repoSweep) */
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
   * Makes the single end-of-review verification STRICT/premise-checking (with
   * package.json / manifest context) instead of recall-biased. Rejects false
   * positives — findings wrong about the code, or whose premise depends on a
   * library version this repo doesn't use. It is still ONE verification pass, not
   * a second review.
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
   * above this line is billed as overage (see accountLimitReason +
   * reportStripeReviewOverage). For NON-metered plans reviewsPerMonth is the
   * hard ceiling instead.
   */
  includedReviewsPerMonth: number | null;
  /** Overage charge, in USD cents, per completed review above the included quota. */
  overageCentsPerReview: number | null;
  /**
   * Which LLM(s) run the review:
   * - 'standard' — the cheaper model (MiniMax-M3) for every pass. Beginner tier.
   * - 'premium'  — the flagship model (GLM-5.2) for every pass.
   * - 'hybrid'   — a TWO-MODEL ENSEMBLE (higher tiers): pass 1 (general) on
   *   MiniMax-M3, pass 2 (deep-dive) on GLM-5.2. Two different models catch
   *   different bugs, so the merged result is the most thorough review — the
   *   premium differentiator.
   */
  modelTier: 'premium' | 'standard' | 'hybrid' | 'openai' | 'codex-hybrid' | 'multi-model' | 'dual-model';
  /** queue priority when workers are saturated (higher = sooner) */
  priority: number;
}

/**
 * Cost model. Every tier now does ONE focused review call (diff + neighborhood +
 * top-K retrieved context) plus a cheap adversarial verification pass — like
 * CodeRabbit/Greptile, NOT a 28-call whole-repo sweep. Real cost is roughly
 * $0.05–$0.20/review (a few cents), a few minutes each — versus the old ~$3 /
 * 25-minute whole-repo sweep that cost more AND reviewed worse (diluted focus).
 *
 * The per-hour/month numbers below are generous SAFETY ceilings (runaway
 * protection), not usage targets — a real team never approaches them. Adjust
 * live via the plan-admin endpoint; set ORVEX_COST_INPUT_PER_M /
 * ORVEX_COST_OUTPUT_PER_M to the provider's real per-token rates for accurate
 * spend tracking.
 */
export const PLANS: Record<PlanId, PlanFeatures> = {
  // PRODUCT RULE (user decision 2026-07-09): every plan runs the SAME settings
  // and thoroughness as Verify — 3 passes, same retrieval depth, strict
  // verification, autofix, and code execution. The ONLY differentiators across
  // tiers are (a) which MODELS run (multi-model w/ Luna on Verify; dual-model
  // MiniMax+DeepSeek elsewhere) and (b) cost/volume levers (rate limits,
  // monthly caps, overage price, queue priority). Review quality, depth, and
  // capability are never the tier differentiator — only price and model mix.
  //
  // ONE deliberate exception: nightlyScans. Unlike every other feature here,
  // scheduled whole-repo scans are NOT counted against trialReviewLimit or any
  // other cap — it's an unbounded daily job per eligible repo, forever. Turning
  // that on for the UNPAID free trial would be a real uncapped-cost bug, not a
  // feature, so it stays paid-tier-only until nightly scans get their own cap.
  free: {
    id: 'free',
    label: 'Free trial',
    reviewPasses: 3,
    retrievalTopK: 28,
    repoSweep: false,
    sweepMaxFiles: 0,
    autofix: true,
    deepReviews: false, // paid-only: ~2x review cost, bounded nowhere on a free account
    codeExecution: true,
    nightlyScans: false, // see the unbounded-cost note above — free stays excluded
    deepVerify: true,
    trialReviewLimit: 10, // 10 free reviews for the account, ever — bounds autofix/execution cost too
    reviewsPerHour: 2,
    reviewsPerMonth: null, // the lifetime cap already bounds free-tier cost; no separate monthly needed
    includedReviewsPerMonth: null,
    overageCentsPerReview: null,
    modelTier: 'dual-model', // trial shows the real product: MiniMax + DeepSeek ensemble
    priority: 0,
  },
  review: {
    id: 'review',
    label: 'Starter', // the MiniMax + DeepSeek ensemble — the entry paid tier
    // $29/mo — 100 reviews/month included, 5/hour (matches CodeRabbit's rate),
    // then $0.50/review overage (re-reviews count as reviews). Full 3-pass
    // pipeline, TWO-MODEL ensemble: MiniMax (general + perf lenses) + DeepSeek
    // v4 Pro at max reasoning effort (deep-dive lens) — different training data
    // catches different bugs, the single biggest lever we found for recall.
    // Same thoroughness/capability set as Verify (autofix, execution, scans) —
    // only the model mix and volume caps differ. COGS ~$0.15/review, so the
    // $0.50 overage is ~3x margin and 100 included worst-cases to $15 COGS.
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
    reviewsPerMonth: 100,
    includedReviewsPerMonth: 100,
    overageCentsPerReview: 50,
    modelTier: 'dual-model',
    priority: 1,
  },
  'review-plus': {
    id: 'review-plus',
    label: 'Pro Unlimited',
    // $69/mo — UNLIMITED reviews at 10/hour (double CodeRabbit's limit, flat for
    // the whole workspace vs their per-seat $24-30). Priced with buffer above the
    // realistic heavy-usage cost curve so a MiniMax price change can't flip it
    // underwater. The 10/hr cap + fair-use bounds the tail; the hourly limit IS
    // the abuse defense, so no monthly ceiling. Same MiniMax + DeepSeek ensemble
    // and same thoroughness/capability set as Verify — more volume, not more depth.
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
    reviewsPerMonth: null,
    includedReviewsPerMonth: null,
    overageCentsPerReview: null,
    modelTier: 'dual-model',
    priority: 1,
  },
  'verify-lite': {
    id: 'verify-lite',
    label: 'Verify Lite',
    // $49/mo — the budget entry to the PREMIUM quality track: the SAME
    // three-model stack as Verify (Luna + DeepSeek + MiniMax), just a smaller
    // quota for lower-volume or price-sensitive teams who still want the
    // frontier-model catch rate. 50 reviews/month included at 5/hour, then
    // $0.75/review overage. COGS ~$0.27/review → 50 × $0.27 = ~$14 worst-case
    // COGS under $49; overage is ~2.8x margin. Everything Verify has, just
    // capped lower — appeals to solo devs and small teams, not just funded ones.
    reviewPasses: 4,
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
    reviewsPerMonth: 50,
    includedReviewsPerMonth: 50,
    overageCentsPerReview: 75,
    modelTier: 'multi-model',
    priority: 2,
  },
  verify: {
    id: 'verify',
    label: 'Verify',
    // multi-model: THREE DIFFERENT MODELS, one per pass — max blind-spot
    // diversity, zero OAuth dependency (pure API billing, no ChatGPT-account
    // fragility to scale across customers):
    //   pass 1 — the frontier OpenAI model (Luna, once its API model ID is
    //            confirmed — currently ORVEX_OPENAI_MODEL, whatever's set);
    //   pass 2 — DeepSeek v4 Pro at max reasoning effort (deep-dive lens);
    //   pass 3 — MiniMax (perf / completeness / API-contract lens);
    // then ONE strict verification on MiniMax (pass-1/openai findings are
    // protected there — the weaker verifier can't override the frontier model).
    // Replaces the earlier codex-CLI design: model diversity across 3 real
    // providers beats a single OAuth-fragile "sharp" pass + 2 MiniMax lenses,
    // and retires the account-pool/proxy/watchdog complexity entirely.
    reviewPasses: 4,
    retrievalTopK: 28, // slightly deeper cross-file context than Panel (+12%)
    repoSweep: false,
    sweepMaxFiles: 0,
    autofix: true,
    deepReviews: true,
    codeExecution: true,
    nightlyScans: true,
    deepVerify: true,
    trialReviewLimit: null,
    // $99/mo tier — 120 reviews/month included at 10/hour, then $0.75/review
    // overage. Real cost ~$0.27/review normal (~$0.50 deep) at Luna's $1/$6 per
    // 1M + DeepSeek + MiniMax, so 120 × $0.50 = $60 worst-case COGS under $99;
    // the $0.75 overage keeps heavy users profitable (~2.8x on a normal review).
    // NOT unlimited by design: Luna's per-review cost means one power user could
    // run the tier negative, so the quota + overage is the cost defense.
    reviewsPerHour: 10,
    reviewsPerMonth: 120,
    includedReviewsPerMonth: 120,
    overageCentsPerReview: 75,
    modelTier: 'multi-model',
    priority: 3,
  },
  enterprise: {
    id: 'enterprise',
    label: 'Enterprise',
    reviewPasses: 4,
    retrievalTopK: 28,
    repoSweep: false,
    sweepMaxFiles: 0,
    autofix: true,
    deepReviews: true,
    codeExecution: true,
    nightlyScans: true,
    deepVerify: true,
    trialReviewLimit: null,
    reviewsPerHour: null,
    reviewsPerMonth: null, // custom-contract tier — negotiated limits, not a code default
    includedReviewsPerMonth: null,
    overageCentsPerReview: null,
    // Enterprise was 'dual-model' — MiniMax + DeepSeek, and NEVER Luna — so the
    // most expensive plan ran a weaker stack than Verify. Now the full
    // four-model ensemble.
    modelTier: 'multi-model',
    priority: 4,
  },
};

/** Plan for a tenant with no explicit plan set — the free trial, so an unknown
 *  or brand-new account never falls through to paid features. Env-overridable. */
export function defaultPlanId(): PlanId {
  const env = process.env.ORVEX_DEFAULT_PLAN as PlanId | undefined;
  // Object.hasOwn, not `in`: 'constructor' in PLANS is TRUE via the prototype
  // chain and would return Object as a "plan".
  return env && Object.hasOwn(PLANS, env) ? env : 'free';
}

/** Resolve a stored plan string (possibly null/unknown) to its feature set. */
export function planFeatures(plan: string | null | undefined): PlanFeatures {
  if (plan && Object.hasOwn(PLANS, plan)) return PLANS[plan as PlanId];
  return PLANS[defaultPlanId()];
}

export function isPlanId(v: string): v is PlanId {
  // Object.hasOwn, not `in`: `'constructor' in PLANS` (and other prototype keys)
  // is true and would pass user-supplied plan strings through to planFeatures.
  return Object.hasOwn(PLANS, v);
}
