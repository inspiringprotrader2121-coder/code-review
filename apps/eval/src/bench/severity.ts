/**
 * Shared severity parsing for the bench tools (competitors / severity-check /
 * judge). Every tool used to carry its own copy of a free-text regex that
 * matched `critical`/`Bug` ANYWHERE in a comment body — so prose like "this is
 * not critical" scored P1 and any mention of "bug" scored P2, corrupting the
 * severity-integrity numbers the tools exist to produce.
 *
 * The parser ANCHORS to the label region:
 *   1. explicit machine labels (P0–P3 tokens, alt-text badges) anywhere;
 *   2. a `Severity: X` label anywhere (labelled, even mid-body);
 *   3. severity keywords ONLY in the comment's head (first ~120 chars, where
 *      tools put their badge/header) — never free text.
 * High/Medium/Low (and Major/Minor) map onto the P1/P2/P3/info taxonomy:
 * Critical/P0/P1→P1, High/Major/P2→P2, Medium/Minor/P3→P3, Low/Info→info.
 */

export type Sev = 'P1' | 'P2' | 'P3' | 'info';

const WORD_TO_SEV: Record<string, Sev> = {
  critical: 'P1',
  high: 'P2',
  major: 'P2',
  medium: 'P3',
  minor: 'P3',
  low: 'info',
  info: 'info',
};

export function severityOf(body: string): Sev | null {
  // 1) Explicit machine labels. P0 folds into P1 (our taxonomy tops out at P1).
  if (/\bP0\b|alt="?P0/i.test(body)) return 'P1';
  if (/\bP1\b|alt="?P1/i.test(body)) return 'P1';
  if (/\bP2\b|alt="?P2/i.test(body)) return 'P2';
  if (/\bP3\b|alt="?P3/i.test(body)) return 'P3';

  // 2) A "Severity: X" label is a label wherever it appears.
  const labelled = /severity:\s*(critical|high|major|medium|minor|low|info)\b/i.exec(body);
  if (labelled) return WORD_TO_SEV[labelled[1].toLowerCase()];

  // 3) Label region only: the head of the comment, where badges/headers live.
  // Negated mentions ("not critical", "no major issue") are stripped first —
  // they are prose, not a label.
  const head = body
    .trim()
    .slice(0, 120)
    .replace(/\b(?:not|n't|no|non-?)\s+(critical|high|major|medium|minor|low|info)\b/gi, '');
  if (/critical|🛑/i.test(head)) return 'P1';
  if (/\bhigh\b|\bmajor\b|action required|potential issue|🐞|⚠️/i.test(head)) return 'P2';
  if (/\bmedium\b|\bminor\b|nitpick|optional|edge case|💡|suggestion/i.test(head)) return 'P3';
  if (/\b(low|info)\b|note:/i.test(head)) return 'info';
  return null;
}

export const sevRank = (s: Sev | string | null): number =>
  s === 'P1' ? 3 : s === 'P2' ? 2 : s === 'P3' ? 1 : 0;
export const isBugSev = (s: Sev | string | null): boolean => s === 'P1' || s === 'P2';
export const isNitSev = (s: Sev | string | null): boolean => s === 'P3' || s === 'info';

/** Max-fold two severities (a cluster's severity is its WORST member's). */
export const worseSev = (a: string | null, b: string | null): string | null =>
  sevRank(b) > sevRank(a) ? b : a;

/**
 * Cluster-line match: same PR+file, lines within ±window. Two findings with NO
 * line (both null) only cluster when they come from the SAME bot — merging
 * every unanchored finding in a file across tools collapsed unrelated defects
 * into one cluster and corrupted both-caught counts.
 */
export function sameClusterLine(
  aLine: number | null,
  bLine: number | null,
  sameBot: boolean,
  window = 5,
): boolean {
  if (aLine === null || bLine === null) return aLine === null && bLine === null && sameBot;
  return Math.abs(aLine - bLine) <= window;
}
