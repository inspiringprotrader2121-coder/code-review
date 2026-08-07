import { createHash } from 'node:crypto';

export interface ReviewFinding {
  file: string;
  line?: number;
  severity: 'P1' | 'P2' | 'P3' | 'info';
  category: string;
  message: string;
  suggestion?: string;
  /** exact source snippet the fix replaces (anchor for safe auto-apply) */
  originalCode?: string;
  /** machine-applicable replacement for originalCode */
  fixedCode?: string;
  confidence: number;
  ruleId: string;
  /** internal: the line was snapped to the nearest changed line because the original line wasn't in the diff */
  lineRelocated?: boolean;
  /** internal: the anchor is on a context line in a deletion-only hunk */
  anchorContext?: boolean;
  /** internal: model tier that produced this finding ('openai' / 'deepseek' /
   *  'deepseek-flash' / 'deterministic' are PROTECTED in verification; 'standard'
   *  / others use the normal gate). */
  sourceTier?: string;
  /** internal: lens / pass tag (e.g. deep-dive, removed-behavior/callers). Used for
   *  contribution reporting when the same tier runs two different lenses. */
  sourcePass?: string;
  /** Bounded corroborating discovery evidence, used only by the verifier. */
  provenance?: FindingProvenance[];
  /** Present when verification evidence-gated a P1→P2 severity correction. */
  severityReason?: string;
}

export interface FindingProvenance {
  sourceTier?: string;
  sourcePass?: string;
  /** Original concrete claim from the producing pass, treated as untrusted data. */
  rationale: string;
  confidence?: number;
}

/** A candidate that is visible in the review summary but intentionally excluded
 * from inline comments, auto-fix, and the persisted open-finding state. */
export interface ReviewSurfaceFinding {
  finding: ReviewFinding;
  reason: string;
}

export function normalizeMessage(message: string): string {
  return message
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s]/g, '')
    .trim()
    .slice(0, 160);
}

/**
 * Version tag on the fingerprint recipe. Bump when the stem changes so old and
 * new fingerprints are distinguishable — prevents a recipe change from silently
 * mismatching every stored fingerprint (false "resolved", re-posts, dead
 * suppressions). Stored fingerprints carry their version as the "vN-" prefix.
 */
const MAX_PROVENANCE_PER_FINDING = 12;

function provenanceKey(item: FindingProvenance): string {
  return [
    item.sourceTier?.trim() ?? '',
    item.sourcePass?.trim() ?? '',
    normalizeMessage(item.rationale),
  ].join('|');
}

/** Return normalized, bounded discovery provenance including the finding itself. */
export function findingProvenance(finding: ReviewFinding): FindingProvenance[] {
  const items: FindingProvenance[] = [
    {
      sourceTier: finding.sourceTier,
      sourcePass: finding.sourcePass,
      rationale: finding.message,
      confidence: finding.confidence,
    },
    ...(finding.provenance ?? []),
  ];
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = provenanceKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, MAX_PROVENANCE_PER_FINDING);
}

/** Attach the producing discovery pass to a fresh model finding. */
export function tagFindingProvenance(
  finding: ReviewFinding,
  sourceTier: string | undefined,
  sourcePass?: string,
): void {
  finding.sourceTier = sourceTier;
  if (sourcePass) finding.sourcePass = sourcePass;
  finding.provenance = findingProvenance(finding);
}

/**
 * Keep corroborating discovery evidence when dedupe or recurrence clustering
 * collapses several reports to one surfaced candidate.
 */
export function mergeFindingProvenance(
  target: ReviewFinding,
  ...sources: ReviewFinding[]
): ReviewFinding {
  const all = [target, ...sources].flatMap(findingProvenance);
  const seen = new Set<string>();
  target.provenance = all.filter((item) => {
    const key = provenanceKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, MAX_PROVENANCE_PER_FINDING);
  return target;
}

export const FINGERPRINT_VERSION = 3;

export function fingerprintFinding(
  f: Pick<ReviewFinding, 'file' | 'ruleId' | 'message'> & { category?: string },
): string {
  // Line-independent on purpose: pushes shift line numbers, and a shifted
  // finding is the SAME finding. Category + a longer message stem reduce
  // collisions between distinct defects that share a short normalized prefix.
  const stem = [f.file, f.ruleId, f.category ?? '', normalizeMessage(f.message)].join('|');
  const hash = createHash('sha256').update(stem).digest('hex').slice(0, 16);
  return `v${FINGERPRINT_VERSION}-${hash}`;
}

export function findingId(fingerprint: string, headSha: string, line?: number): string {
  return `${fingerprint}-${line ?? 0}-${headSha.slice(0, 7)}`;
}
