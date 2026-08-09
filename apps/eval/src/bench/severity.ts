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

/**
 * Markdown/HTML emphasis and badge markup, removed BEFORE the head window is
 * taken. Two separate measurement bugs made this necessary:
 *
 *  1. `\b` does not fire between `_` and a letter, because `_` is a word
 *     character. CodeRabbit's real inline header is `_🛠️ Refactor suggestion_ |
 *     _🟠 Major_`, so `/\bmajor\b/` could NEVER match it; the line fell through
 *     to the unanchored `suggestion` token and a competitor's MAJOR was scored
 *     as a P3 nitpick — removing it from the "Orvex missed" ledger entirely.
 *  2. The head window was sliced from the RAW body, so any tool that leads with
 *     an <img> badge or <table> header (greptile, qodo) spent all 120 chars on
 *     markup and returned null. The repo had already recorded the symptom
 *     without anyone reading it: `coderabbit: unrated 15/17`, `qodo: 10/26`.
 *
 * Both biases under-read COMPETITORS only — Orvex emits clean `**P1**` labels
 * that parse fine — so they inflated our lead in the same direction as the
 * finding-source asymmetry. Strip first, then match.
 */
function stripMarkup(s: string): string {
  return s
    .replace(/<[^>]+>/g, ' ') // html tags & badges
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // image/badge markdown
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links -> their text
    .replace(/[_*`~]+/g, ' ') // emphasis delimiters -> space, so \b works
    .replace(/\s+/g, ' ');
}

/** Word match that treats `_`/`*` as delimiters rather than word characters. */
const word = (w: string) => new RegExp(`(?<![A-Za-z0-9])(?:${w})(?![A-Za-z0-9])`, 'i');

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
  const head = stripMarkup(body)
    .trim()
    .slice(0, 120)
    .replace(
      /(?<![A-Za-z0-9])(?:not|n't|no|non-?)\s+(critical|high|major|medium|minor|low|info)(?![A-Za-z0-9])/gi,
      '',
    );
  if (word('critical').test(head) || /🛑/.test(head)) return 'P1';
  if (word('high|major').test(head) || /action required|potential issue|🐞|⚠️/i.test(head))
    return 'P2';
  if (word('medium|minor|nitpick|optional|suggestion').test(head) || /edge case|💡/i.test(head))
    return 'P3';
  if (word('low|info').test(head) || /note:/i.test(head)) return 'info';
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

/**
 * True when an Orvex comment is bookkeeping (progress/status/apply chatter)
 * rather than a finding.
 *
 * Every alternative is anchored to the START of the body. The previous form
 * anchored only the emoji and `## Orvex Review` alternatives, leaving
 * `**Applying`, `**Fix applied`, `already reviewed` and `safety limit` free to
 * match ANYWHERE — which dropped real findings two ways:
 *
 *  - `format.ts` writes the apply line INTO the existing inline finding comment,
 *    so every finding a user auto-fixed was classified as status and discarded.
 *    It survived only because the summary table is parsed too — meaning the
 *    inline/table asymmetry had quietly become load-bearing for correctness.
 *  - Any finding whose prose happened to say "the safety limit check is
 *    bypassed" or "already reviewed by middleware" was silently dropped.
 */
export const isOrvexStatusComment = (body: string): boolean =>
  /^\s*(?:[🔄✅⏳]|\*\*Applying|\*\*Fix applied|## Orvex Review|already reviewed|safety limit)/i.test(
    body.trim(),
  );
