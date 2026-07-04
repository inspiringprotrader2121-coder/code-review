import type { ReviewConfig } from '@orvex-review/rules';
import type { ReviewFinding } from './finding.js';

const SEVERITY_RANK: Record<string, number> = { P1: 0, P2: 1, P3: 2, info: 3 };

export function filterAndCapFindings(
  findings: ReviewFinding[],
  config: ReviewConfig,
): { inline: ReviewFinding[]; summaryOnly: ReviewFinding[] } {
  const sorted = [...findings].sort(
    (a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9),
  );

  const capped = sorted.slice(0, config.max_comments);
  const inline: ReviewFinding[] = [];
  const summaryOnly: ReviewFinding[] = [];

  for (const f of capped) {
    // Only actionable, well-anchored, confident findings earn an inline comment
    // (which carries the fix checkbox). Low-severity or lower-confidence items
    // go to the summary — this is the main lever against inline noise.
    const actionable = f.severity === 'P1' || f.severity === 'P2';
    const confident = f.confidence >= config.inline_min_confidence;
    if (typeof f.line === 'number' && actionable && confident) inline.push(f);
    else summaryOnly.push(f);
  }

  return { inline, summaryOnly };
}

export function dedupeByFileLine(findings: ReviewFinding[]): ReviewFinding[] {
  const seen = new Set<string>();
  const out: ReviewFinding[] = [];
  for (const f of findings) {
    const key = `${f.file}:${f.line ?? 0}:${f.ruleId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}
