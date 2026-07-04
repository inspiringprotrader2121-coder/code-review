import type { ReviewFinding } from './finding.js';

/**
 * Phrases where the model is arguing AGAINST its own finding — it flags
 * something while admitting it doesn't matter. These are count-padding noise:
 * a finding that concedes "impact is nil" should never reach the author.
 */
const SELF_NEGATING = [
  'impact is nil',
  'impact is negligible',
  'no practical impact',
  'no real impact',
  'no functional impact',
  'not a bug',
  'not actually a bug',
  'is harmless',
  'are harmless',
  'harmless here',
  'purely stylistic',
  'purely cosmetic',
  'just a style',
  'nitpick',
  'none expected in practice',
  'never contains these',
  'unlikely to ever',
  'in practice never',
  'flagging as p3 to call out',
  'flagging to call out',
  'for completeness',
  'not strictly a defect',
  'not strictly a bug',
];

const HEDGE_OPENERS = [
  'consider ',
  'you might want to',
  'it would be nice',
  'as a minor',
  'minor:',
  'nit:',
];

function lower(s: string): string {
  return s.toLowerCase();
}

/**
 * Drop findings whose own message signals the model doesn't believe it matters.
 * These are the "impact is nil, flagging as P3 to call out" comments — the
 * dominant source of review noise. Returns the survivors and the dropped ones.
 */
export function dropSelfNegatingFindings(findings: ReviewFinding[]): {
  kept: ReviewFinding[];
  dropped: ReviewFinding[];
} {
  const kept: ReviewFinding[] = [];
  const dropped: ReviewFinding[] = [];
  for (const f of findings) {
    // A P1/P2 that hedges is likely mis-severitied, not noise — keep it and let
    // verification/severity re-triage handle it. Only low-severity self-negating
    // findings are dropped as count-padding.
    const isLowSeverity = f.severity === 'P3' || f.severity === 'info';
    if (!isLowSeverity) {
      kept.push(f);
      continue;
    }
    const msg = lower(f.message);
    const negates = SELF_NEGATING.some((p) => msg.includes(p));
    const opensAsHedge = HEDGE_OPENERS.some((p) => msg.startsWith(p));
    if (negates || opensAsHedge) dropped.push(f);
    else kept.push(f);
  }
  return { kept, dropped };
}
