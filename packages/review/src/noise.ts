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
  'none expected in practice',
  'never contains these',
  'unlikely to ever',
  'in practice never',
  'flagging as p3 to call out',
  'flagging to call out',
  'not strictly a defect',
  'not strictly a bug',
];

/** Whole-message / phrase hedges — NOT bare substrings like "nitpick" inside a real scenario. */
const SELF_NEGATING_PHRASES = [
  /\bnitpick\b/,
  /\bfor completeness\b/,
];

const HEDGE_OPENERS = [
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
// Our secret-redactor replaces leaked tokens with markers that all end in
// `REDACTED]` ([REDACTED], sk-[REDACTED], [STRIPE_KEY_REDACTED], …). A finding
// that quotes one of these was reasoned FROM censored input — the model can't
// have seen the real value, so any claim about it is a hallucination (PR112 #7:
// a P2 "broken test — token is [REDACTED]" filed on Orvex's OWN redaction). Drop
// at ALL severities, since it's not a severity-triage problem.
const REDACTION_MARKER = /REDACTED\]/;
function citesRedactedInput(f: ReviewFinding): boolean {
  return (
    REDACTION_MARKER.test(f.message) ||
    REDACTION_MARKER.test(f.originalCode ?? '') ||
    REDACTION_MARKER.test(f.fixedCode ?? '')
  );
}

export function dropSelfNegatingFindings(findings: ReviewFinding[]): {
  kept: ReviewFinding[];
  dropped: ReviewFinding[];
} {
  const kept: ReviewFinding[] = [];
  const dropped: ReviewFinding[] = [];
  for (const f of findings) {
    // Reasoned from redacted input → hallucination. Drop regardless of severity.
    if (citesRedactedInput(f)) {
      dropped.push(f);
      continue;
    }
    // A P1/P2 that hedges is likely mis-severitied, not noise — keep it and let
    // verification/severity re-triage handle it. Only low-severity self-negating
    // findings are dropped as count-padding.
    const isLowSeverity = f.severity === 'P3' || f.severity === 'info';
    if (!isLowSeverity) {
      kept.push(f);
      continue;
    }
    const msg = lower(f.message);
    const negates =
      SELF_NEGATING.some((p) => msg.includes(p))
      || SELF_NEGATING_PHRASES.some((re) => re.test(msg));
    // Hedge openers only drop `info` — a P3 that starts with "Consider …" often
    // describes a real medium defect and must reach the author/verifier.
    const opensAsHedge = f.severity === 'info' && HEDGE_OPENERS.some((p) => msg.startsWith(p));
    if (negates || opensAsHedge) dropped.push(f);
    else kept.push(f);
  }
  return { kept, dropped };
}
