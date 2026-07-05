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
    // Any finding anchored to a changed line gets an inline comment so it
    // carries its own apply-fix checkbox. Only findings we couldn't anchor to
    // the diff (no line) fall back to the summary list.
    if (typeof f.line === 'number') inline.push(f);
    else summaryOnly.push(f);
  }

  // Findings past max_comments are surfaced in the summary table rather than
  // silently discarded — never drop a real finding, even when capping noise.
  summaryOnly.push(...sorted.slice(config.max_comments));

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
