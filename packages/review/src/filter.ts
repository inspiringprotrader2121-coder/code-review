import type { ReviewConfig } from '@orvex-review/rules';
import type { ReviewFinding } from './finding.js';

const SEVERITY_RANK: Record<string, number> = { P1: 0, P2: 1, P3: 2, info: 3 };

/** What gets FOLDED into the collapsed section instead of shown inline. `info`
 *  (Low/nitpick) is always folded; P3 (Medium) is a real bug and is surfaced
 *  inline by default — folded only when a repo opts in via fold_medium. */
const isFolded = (f: ReviewFinding, foldMedium: boolean): boolean =>
  f.severity === 'info' || (foldMedium && f.severity === 'P3');

export function filterAndCapFindings(
  findings: ReviewFinding[],
  config: ReviewConfig,
): { inline: ReviewFinding[]; summaryOnly: ReviewFinding[]; nitpicks: ReviewFinding[] } {
  const sorted = [...findings].sort(
    (a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9),
  );

  // Signal vs folded: Critical/High/Medium (P1/P2/P3) are real bugs and get inline
  // line-comments; only Low/info is collapsed into the folded "nitpicks" section
  // by default. A repo can additionally fold Medium via fold_medium. Folded
  // findings are still surfaced, just collapsed.
  const foldMedium = (config as { fold_medium?: boolean }).fold_medium ?? false;
  const actionable = sorted.filter((f) => !isFolded(f, foldMedium));
  const nitpicks = sorted.filter((f) => isFolded(f, foldMedium));

  // Cap applies to the visible inline (actionable) comments, not the folded nitpicks.
  const capped = actionable.slice(0, config.max_comments);
  const inline: ReviewFinding[] = [];
  const summaryOnly: ReviewFinding[] = [];

  for (const f of capped) {
    // Confidence is telemetry, not an output gate. Severity and a usable diff
    // anchor determine the normal review surface; the verifier may still demote
    // a concretely refuted candidate to manual review with its evidence.
    if (typeof f.line === 'number') inline.push(f);
    else summaryOnly.push(f);
  }

  // Actionable findings past max_comments go to the summary table, never dropped.
  summaryOnly.push(...actionable.slice(config.max_comments));

  return { inline, summaryOnly, nitpicks };
}

const DEDUP_SEV_RANK: Record<string, number> = { info: 0, P3: 1, P2: 2, P1: 3 };

/**
 * Collapse findings that share a file:line:rule. Keeps the HIGHEST-severity one
 * (tie → the more detailed message), preserving first-seen order. Run this BOTH
 * before anchoring AND after normalizeFindingLine — two findings from different
 * passes (e.g. codex general + MiniMax deep-dive) can describe the same defect
 * and only collide on line number AFTER being snapped to the nearest added line,
 * so a single pre-anchor pass leaves duplicate inline comments.
 */
export function dedupeByFileLine(findings: ReviewFinding[]): ReviewFinding[] {
  const best = new Map<string, ReviewFinding>();
  const order: string[] = [];
  for (const f of findings) {
    const key = `${f.file}:${f.line ?? 0}:${f.ruleId}`;
    const existing = best.get(key);
    if (!existing) {
      best.set(key, f);
      order.push(key);
      continue;
    }
    const fRank = DEDUP_SEV_RANK[f.severity] ?? 0;
    const eRank = DEDUP_SEV_RANK[existing.severity] ?? 0;
    if (fRank > eRank || (fRank === eRank && f.message.length > existing.message.length)) {
      best.set(key, f);
    }
  }
  return order.map((k) => best.get(k)!);
}
