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

export type PlanId = 'free' | 'review' | 'verify' | 'enterprise';

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
  /** Tier 2: run the change in a sandbox, run tests, attach runtime evidence */
  codeExecution: boolean;
  /** Tier 2: scheduled whole-repo bug scans that open fix PRs */
  nightlyScans: boolean;
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
   * Which LLM(s) run the review:
   * - 'standard' — the cheaper model (MiniMax-M3) for every pass. Beginner tier.
   * - 'premium'  — the flagship model (GLM-5.2) for every pass.
   * - 'hybrid'   — a TWO-MODEL ENSEMBLE (higher tiers): pass 1 (general) on
   *   MiniMax-M3, pass 2 (deep-dive) on GLM-5.2. Two different models catch
   *   different bugs, so the merged result is the most thorough review — the
   *   premium differentiator.
   */
  modelTier: 'premium' | 'standard' | 'hybrid';
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
  free: {
    id: 'free',
    label: 'Free trial',
    reviewPasses: 1,
    retrievalTopK: 10,
    repoSweep: false,
    sweepMaxFiles: 0,
    autofix: false,
    codeExecution: false,
    nightlyScans: false,
    trialReviewLimit: 10, // 10 free reviews for the account, ever
    reviewsPerHour: 2,
    reviewsPerMonth: null, // the lifetime cap already bounds free-tier cost; no separate monthly needed
    modelTier: 'standard', // trial runs on the cheaper model
    priority: 0,
  },
  review: {
    id: 'review',
    label: 'Review',
    // Runs the SAME review pipeline as Verify (2-pass deep-dive, deep retrieval,
    // verification) — the difference is the MODEL: Review uses the cheaper
    // 'standard' model (MiniMax, ~4x cheaper/token), Verify uses the flagship.
    // Verify additionally gets code execution + nightly scans.
    reviewPasses: 2,
    retrievalTopK: 25,
    repoSweep: false,
    sweepMaxFiles: 0,
    autofix: true,
    codeExecution: false,
    nightlyScans: false,
    trialReviewLimit: null,
    reviewsPerHour: 30,
    reviewsPerMonth: 550,
    modelTier: 'standard',
    priority: 1,
  },
  verify: {
    id: 'verify',
    label: 'Verify',
    // TWO focused passes: pass 1 general, pass 2 a DEEP-DIVE (data-integrity /
    // migration / security / concurrency / edge-case bugs the first misses).
    // Plus deeper retrieval, the adversarial verification pass, and runtime code
    // execution. Depth comes from a second FOCUSED lens — not a whole-repo sweep
    // (that cost ~$3 / 25 min AND diluted quality). Review stays single-pass/cheap.
    reviewPasses: 2,
    retrievalTopK: 25,
    repoSweep: false,
    sweepMaxFiles: 0,
    autofix: true,
    codeExecution: true,
    nightlyScans: true,
    trialReviewLimit: null,
    reviewsPerHour: 30,
    reviewsPerMonth: 550,
    modelTier: 'hybrid', // two-model ensemble: MiniMax (pass 1) + GLM-5.2 (pass 2)
    priority: 2,
  },
  enterprise: {
    id: 'enterprise',
    label: 'Enterprise',
    reviewPasses: 2,
    retrievalTopK: 35,
    repoSweep: false,
    sweepMaxFiles: 0,
    autofix: true,
    codeExecution: true,
    nightlyScans: true,
    trialReviewLimit: null,
    reviewsPerHour: null,
    reviewsPerMonth: null, // custom-contract tier — negotiated limits, not a code default
    modelTier: 'hybrid', // two-model ensemble: MiniMax (pass 1) + GLM-5.2 (pass 2)
    priority: 3,
  },
};

/** Plan for a tenant with no explicit plan set — the free trial, so an unknown
 *  or brand-new account never falls through to paid features. Env-overridable. */
export function defaultPlanId(): PlanId {
  const env = process.env.ORVEX_DEFAULT_PLAN as PlanId | undefined;
  return env && env in PLANS ? env : 'free';
}

/** Resolve a stored plan string (possibly null/unknown) to its feature set. */
export function planFeatures(plan: string | null | undefined): PlanFeatures {
  if (plan && plan in PLANS) return PLANS[plan as PlanId];
  return PLANS[defaultPlanId()];
}

export function isPlanId(v: string): v is PlanId {
  return v in PLANS;
}
