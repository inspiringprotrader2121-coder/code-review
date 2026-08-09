import type { ReviewConfig } from '@orvex-review/rules';
import { loadReviewRuntimeConfig } from '@orvex-review/config';
import { mergeFindingProvenance, type ReviewFinding } from './finding.js';
import { sameDefectText } from './similarity.js';

const SEVERITY_RANK: Record<string, number> = { P1: 0, P2: 1, P3: 2, info: 3 };

/** What gets FOLDED into the collapsed section instead of shown inline. `info`
 *  (Low/nitpick) is always folded; P3 (Medium) is a real bug and is surfaced
 *  inline by default — folded only when a repo opts in via fold_medium. */
const isFolded = (f: ReviewFinding, foldMedium: boolean): boolean =>
  f.severity === 'info' || (foldMedium && f.severity === 'P3');

/** What makes a finding STARTABLE: the input or state that sets it off. */
const TRIGGER_RE =
  /\b(?:when|whenever|if|once|after|during|on\s+(?:retry|failure|error|restart|reload|refresh|conflict)|concurrent|simultaneous|race|first\s+run|fresh|empty|missing|null|undefined|expired|two|multiple|attacker|unauthenticated|cross-tenant)\b/i;

/** What makes it MATTER: the observable wrong outcome. */
const CONSEQUENCE_RE =
  /\b(?:fails?|failing|throws?|crash(?:es|ing)?|rejects?|returns?|404|500|hangs?|times?\s*out|deadlock|lost|loses|losing|dropped?|drops|leaks?|leaking|stale|wrong|incorrect|duplicate[sd]?|overwrit(?:e|es|ing|ten)|corrupt(?:s|ed|ion)?|bypass(?:es|ed)?|skips?|skipped|never\s+(?:runs?|fires?|releases?|increments?)|silently|unbounded|exceeds?|truncat(?:e|es|ed|ion)|denied|exposed?|billed?|charged?)\b/i;

/**
 * True when a finding names both a trigger and a consequence.
 *
 * The review prompt already requires "a concrete FAILURE SCENARIO (input/state
 * → wrong outcome)" for every finding, so a message with neither is failing our
 * own contract. Benchmarking against Greptile v5 showed Orvex posting several
 * times as many inline comments per PR, and the surplus was concentrated in
 * exactly these unfalsifiable P3 observations ("this pattern is risky",
 * "consider validating") that a reader cannot act on or dismiss.
 *
 * Deliberately used ONLY to choose a SURFACE, never to drop a finding: P1
 * always posts inline, and a gated P2/P3 still appears in the summary table with
 * its apply-fix checkbox. A wrong call here costs prominence, not the finding.
 */
export function hasConcreteFailurePath(message: string): boolean {
  const text = message.trim();
  // Very short messages cannot carry a scenario; the threshold is well below
  // any real finding we emit and exists to catch one-line assertions.
  if (text.length < 80) return false;
  return TRIGGER_RE.test(text) && CONSEQUENCE_RE.test(text);
}

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

  // Findings that cannot state what triggers them and what goes wrong are the
  // bulk of our excess comment volume vs Greptile (median 5 vs 1 inline/PR).
  // They go to the summary table instead of the diff. P1 is never gated — a
  // marquee bug always earns an inline comment. P2/P3 must earn the surface.
  // Gated, never dropped: the finding still reaches the author with its
  // apply-fix checkbox.
  const evidenceGate = loadReviewRuntimeConfig().inlineEvidenceGate;
  const earnsInline = (f: ReviewFinding): boolean => {
    if (!evidenceGate) return true;
    if (f.severity === 'P1') return true;
    return hasConcreteFailurePath(f.message);
  };

  for (const f of capped) {
    // Confidence is telemetry, not an output gate. Severity and a usable diff
    // anchor determine the normal review surface; the verifier may still demote
    // a concretely refuted candidate to manual review with its evidence.
    if (typeof f.line === 'number' && earnsInline(f)) inline.push(f);
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
/**
 * How far apart two anchors in one file may sit and still be one defect.
 * Kept modest: distant anchors need stronger lexical proof (below).
 */
const SAME_DEFECT_LINE_WINDOW = 120;
/** Within this distance, ordinary sameDefectText proof is enough. */
const SAME_DEFECT_NEAR_WINDOW = 40;

/**
 * Collapse findings that describe ONE defect anchored to different lines of the
 * same file.
 *
 * `dedupeByFileLine` only catches an exact `file:line:ruleId` collision, so two
 * passes that blamed different statements of the same bug — or the same
 * statement under different rule ids — each posted their own inline comment.
 * Benchmarking against Greptile v5 found this in our own output: one OpenAPI
 * drift reported at `ApiDocs.jsx:42` and again at `:48`, one GDPR continuation
 * defect at `gdpr.js:56` and `:76`. Two comments for one bug is the largest
 * controllable part of "Orvex is noisier per PR".
 *
 * Runs AFTER `dedupeByFileLine` so exact collisions are already gone, and keeps
 * the highest-severity copy (tie → the more detailed message) with provenance
 * merged, exactly like the exact-match path.
 */
export function collapseSameDefect(findings: ReviewFinding[]): ReviewFinding[] {
  const kept: ReviewFinding[] = [];
  for (const f of findings) {
    const match = kept.find((k) => {
      if (k.file !== f.file) return false;
      // A finding with no anchor could belong anywhere in the file; requiring
      // both lines keeps the collapse to cases we can actually place.
      if (typeof k.line !== 'number' || typeof f.line !== 'number') return false;
      const dist = Math.abs(k.line - f.line);
      if (dist > SAME_DEFECT_LINE_WINDOW) return false;
      const text = sameDefectText(k.message, f.message);
      if (!text.match) return false;
      // Far-apart anchors: require identifier proof, not term-only overlap, so
      // unrelated defects in a large file do not collapse.
      if (dist > SAME_DEFECT_NEAR_WINDOW) {
        return text.sharedSymbols.length >= 2 || /rare identifier/.test(text.reason);
      }
      return true;
    });
    if (!match) {
      kept.push(f);
      continue;
    }
    const fRank = DEDUP_SEV_RANK[f.severity] ?? 0;
    const mRank = DEDUP_SEV_RANK[match.severity] ?? 0;
    if (fRank > mRank || (fRank === mRank && f.message.length > match.message.length)) {
      mergeFindingProvenance(f, match);
      kept[kept.indexOf(match)] = f;
    } else {
      mergeFindingProvenance(match, f);
    }
  }
  return kept;
}

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
      mergeFindingProvenance(f, existing);
      best.set(key, f);
    } else {
      mergeFindingProvenance(existing, f);
    }
  }
  return order.map((k) => best.get(k)!);
}
