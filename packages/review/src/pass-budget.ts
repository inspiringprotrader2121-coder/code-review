import { DEEP_DIVE_FOCUS, THIRD_ANGLE_FOCUS } from './lenses.js';
import { loadReviewRuntimeConfig } from '@orvex-review/config';
import { compileReviewPlan, type ReviewStage } from './review-plan.js';

/**
 * How many single-hypothesis probes a plan may run.
 *
 * Default budget for Verify/codex-hybrid is 2 (second only if selective).
 * Entry tiers stay at 1. Override with ORVEX_RISK_PROBES.
 */
export function maxRiskProbes(plan: { modelTier?: string }): number {
  const override = loadReviewRuntimeConfig().riskProbes;
  if (override !== undefined) return override;
  return plan.modelTier === 'codex-hybrid' || plan.modelTier === 'multi-model' ? 2 : 1;
}

/**
 * Pick which risk probes to actually spend a Flash call on.
 *
 * Always takes the top signal when budget >= 1. A second probe is only spent
 * when the top hypothesis is narrowly scoped (few files) relative to the next
 * one — otherwise the second call mostly rediscovers the first.
 */
export function selectRiskProbes<T extends { files: readonly string[] }>(
  signals: readonly T[],
  budget: number,
): T[] {
  if (budget <= 0 || signals.length === 0) return [];
  if (budget === 1 || signals.length === 1) return [signals[0]!];
  const top = signals[0]!;
  const second = signals[1]!;
  const ratio = loadReviewRuntimeConfig().riskProbeSelectivity;
  const topNarrow = top.files.length > 0 && top.files.length <= 2;
  const muchNarrower = top.files.length > 0 && second.files.length >= top.files.length * ratio;
  if (topNarrow || muchNarrower) return signals.slice(0, Math.min(budget, 2));
  return [top];
}

/** True when the PR is large enough that the breadth lens is worth a call.
 *
 * Tuned up from 25 files / 80k chars: the breadth + removed-behavior lenses
 * mostly rediscover what general + deep-dive already catch on ordinary PRs, so
 * running them unconditionally cost a full extra LLM round-trip per review with
 * little marginal recall. Reserve them for genuinely large diffs (or an explicit
 * `@orvex deep`), where the extra breadth actually pays. Env overrides remain. */
export function isLargePr(
  files: ReadonlyArray<{ filename?: string; patch?: string | null }>,
): boolean {
  const maxFiles = loadReviewRuntimeConfig().largePrFiles;
  if (files.length >= maxFiles) return true;
  const maxChars = loadReviewRuntimeConfig().largePrPatchChars;
  let chars = 0;
  for (const f of files) {
    chars += f.patch?.length ?? 0;
    if (chars >= maxChars) return true;
  }
  return false;
}

/** True when the diff deletes or renames paths — the removed-behavior lens's job. */
export function hasDeleteOrRename(
  files: ReadonlyArray<{
    status?: string;
    previous_filename?: string | null;
    previousFilename?: string | null;
  }>,
): boolean {
  return files.some(
    (f) =>
      f.status === 'removed' ||
      f.status === 'renamed' ||
      Boolean(f.previous_filename) ||
      Boolean(f.previousFilename),
  );
}

export type PassAngle = {
  /** Present for public fixed tiers. This is the authoritative stage contract
   * used by execution; numeric indexes remain only for legacy routing. */
  stage?: ReviewStage;
  tag: string;
  focus?: string;
  bestEffort?: boolean;
  /**
   * Stable model-routing slot for multi-model plans. Must NOT be derived from
   * the compacted array index. Slot 2 remains reserved for historical records
   * and optional lenses, so breadth keeps its established MiniMax routing and
   * context partition after the standalone removed-behaviour stage was folded
   * into the Flash deep-dive.
   *   0 = general (frontier/Codex)
   *   1 = combined deep-dive/caller audit (Flash)
   *   2 = reserved legacy/optional lens slot
   *   3 = breadth (MiniMax)
   */
  modelIdx: number;
};

/**
 * Build the discovery lens list for this review.
 *
 * Multi-model / Verify / Enterprise always run three discovery passes
 * (Luna/Codex + one combined Flash deep-dive/caller audit + MiniMax breadth),
 * then Flash verify when there are candidates. That is the paid precision track.
 *
 * Dual-model (Free/Starter/Pro) stays at general + deep-dive only.
 *
 * Multi-model routing is intentionally not environment-conditional: changing a
 * flag must not reduce a purchased three-reviewer run to two reviewers.
 */
export function buildReviewPassAngles(opts: {
  modelTier?: string;
  deep?: boolean;
  files: ReadonlyArray<{
    filename?: string;
    patch?: string | null;
    status?: string;
    previous_filename?: string | null;
    previousFilename?: string | null;
  }>;
}): PassAngle[] {
  const tier = opts.modelTier;
  const fixedPlan = compileReviewPlan(tier);
  if (fixedPlan) {
    return fixedPlan.discovery.map((stage) => ({
      stage,
      tag: stage.tag,
      focus: stage.focus,
      modelIdx: stage.modelIndex,
      bestEffort: !stage.required,
    }));
  }

  const breadthMode = loadReviewRuntimeConfig().breadthMode;
  const large = isLargePr(opts.files);
  const wantBreadth =
    breadthMode === 'always' || (breadthMode !== 'never' && (Boolean(opts.deep) || large));

  const angles: PassAngle[] = [
    { tag: 'general', modelIdx: 0 },
    { tag: 'deep-dive', focus: DEEP_DIVE_FOCUS, modelIdx: 1 },
  ];
  if (wantBreadth) {
    angles.push({
      tag: 'perf/completeness/api',
      focus: THIRD_ANGLE_FOCUS,
      bestEffort: true,
      modelIdx: 3,
    });
  }
  return angles;
}
