import { DEEP_DIVE_FOCUS, REMOVED_BEHAVIOR_FOCUS, THIRD_ANGLE_FOCUS } from './lenses.js';

/**
 * How many single-hypothesis probes a plan may run.
 *
 * Default budget for Verify/codex-hybrid is 2 (second only if selective).
 * Entry tiers stay at 1. Override with ORVEX_RISK_PROBES.
 */
export function maxRiskProbes(plan: { modelTier?: string }): number {
  const override = Number(process.env.ORVEX_RISK_PROBES);
  if (Number.isFinite(override) && override >= 0) return Math.min(4, Math.floor(override));
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
  const ratioRaw = Number(process.env.ORVEX_RISK_PROBE_SELECTIVITY ?? 2);
  const ratio = Number.isFinite(ratioRaw) && ratioRaw >= 1.5 ? ratioRaw : 2;
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
  const fileCap = Number(process.env.ORVEX_LARGE_PR_FILES ?? 40);
  const maxFiles = Number.isFinite(fileCap) && fileCap > 0 ? Math.floor(fileCap) : 40;
  if (files.length >= maxFiles) return true;
  const charCap = Number(process.env.ORVEX_LARGE_PR_PATCH_CHARS ?? 150_000);
  const maxChars = Number.isFinite(charCap) && charCap > 0 ? Math.floor(charCap) : 150_000;
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
      f.status === 'removed'
      || f.status === 'renamed'
      || Boolean(f.previous_filename)
      || Boolean(f.previousFilename),
  );
}

export type PassAngle = {
  tag: string;
  focus?: string;
  bestEffort?: boolean;
  /**
   * Stable model-routing slot for multi-model plans. Must NOT be derived from
   * the compacted array index — when removed-behavior is omitted, breadth used
   * to shift into passIndex 2 and get Flash instead of MiniMax.
   *   0 = general (frontier/Codex)
   *   1 = deep-dive (Flash)
   *   2 = removed-behavior (Flash/Pro)
   *   3 = breadth (MiniMax)
   */
  modelIdx: number;
};

/**
 * Build the discovery lens list for this review.
 *
 * Default Verify path aims at ~2 discovery passes (general + deep-dive).
 * Breadth and removed-behavior are conditional so ordinary PRs stop paying for
 * overlapping lenses that mostly rediscover.
 *
 * Env:
 *   ORVEX_BREADTH_ON=deep-or-large|always|never  (default deep-or-large)
 *   ORVEX_REMOVED_BEHAVIOR=deletes-or-renames|always|never  (default deletes-or-renames)
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
  const fourthTier = tier === 'multi-model' || tier === 'codex-hybrid';
  const breadthMode = (process.env.ORVEX_BREADTH_ON ?? 'deep-or-large').trim().toLowerCase();
  const removedMode = (process.env.ORVEX_REMOVED_BEHAVIOR ?? 'deletes-or-renames').trim().toLowerCase();
  const large = isLargePr(opts.files);
  const wantRemoved =
    fourthTier
    && (
      removedMode === 'always'
      || (removedMode !== 'never' && hasDeleteOrRename(opts.files))
    );
  const wantBreadth =
    breadthMode === 'always'
    || (breadthMode !== 'never' && (Boolean(opts.deep) || large));

  const angles: PassAngle[] = [
    { tag: 'general', modelIdx: 0 },
    { tag: 'deep-dive', focus: DEEP_DIVE_FOCUS, modelIdx: 1 },
  ];
  if (wantRemoved) {
    angles.push({
      tag: 'removed-behavior/callers',
      focus: REMOVED_BEHAVIOR_FOCUS,
      modelIdx: 2,
    });
  }
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
