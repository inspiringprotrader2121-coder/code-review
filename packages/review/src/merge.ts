import type { StoredFinding } from '@orvex-review/store';
import { auditDocIssuesOpenOnHead } from '@orvex-review/rules';
import type { ReviewFinding, ReviewSurfaceFinding } from './finding.js';
import { fingerprintFinding, findingId } from './finding.js';

export interface FileReader {
  readFile(path: string, ref: string): Promise<string | null>;
}

export interface VerifyResult {
  /** true if the finding is still open on HEAD */
  open: boolean;
  /** true only if we GENUINELY verified the finding (audit rules). */
  genuine: boolean;
  /** true if we could not read the file (transient error) — must not mark fixed */
  readError?: boolean;
}

export async function verifyFindingOnHead(
  finding: Pick<ReviewFinding, 'file' | 'ruleId' | 'message' | 'category' | 'originalCode' | 'fixedCode'> & { severity: string },
  headSha: string,
  reader: FileReader,
): Promise<VerifyResult> {
  let content: string | null;
  try {
    content = await reader.readFile(finding.file, headSha);
  } catch {
    // Transient read failure (rate-limit, 5xx). Don't treat as "fixed".
    return { open: true, genuine: false, readError: true };
  }
  if (!content) {
    // File genuinely missing (404) → the code is gone, so the finding is fixed.
    return { open: false, genuine: true };
  }

  if (finding.ruleId.startsWith('audit.')) {
    return { open: auditDocIssuesOpenOnHead(content, finding.file), genuine: true };
  }

  // Deterministic fix detection: retire a finding ONLY when we can see the EXACT
  // recorded fix landed — the flagged `originalCode` is gone AND the recorded
  // `fixedCode` is now present. Both anchors must be reliable (see fixLanded).
  // This is the ONLY path that may close P1/P2; mergeFindings never retires them
  // solely because the model missed them on a new SHA.
  if (fixLanded(finding.originalCode, finding.fixedCode, content)) {
    return { open: false, genuine: true };
  }

  // No proof of a fix: carry it forward WITHOUT stamping lastSeenSha, so
  // mergeFindings' "model didn't re-surface it" + flip-flop guards decide
  // (P3/info only — P1/P2 stay open there).
  return { open: true, genuine: false };
}

/** Whitespace-normalize so a pure reformat (reindent / rewrap) of otherwise
 *  identical code doesn't read as either a match or a fix. */
function normalizeCode(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * True only when the RECORDED fix is demonstrably present: the flagged snippet is
 * gone AND the recorded `fixedCode` is now in the file. Both must be reliable
 * anchors (long enough, containing a real identifier) so boilerplate can't
 * trigger it. Without a recorded fixedCode there is nothing to corroborate, so we
 * return false and let mergeFindings' model-recall guard decide — that is what
 * prevents an incidental line edit from false-closing a still-open bug.
 */
function fixLanded(originalCode: string | undefined, fixedCode: string | undefined, content: string): boolean {
  const orig = normalizeCode(originalCode ?? '');
  const fixed = normalizeCode(fixedCode ?? '');
  const reliable = (s: string) => s.length >= 12 && /[A-Za-z_][A-Za-z0-9_]{2,}/.test(s);
  if (!reliable(orig) || !reliable(fixed) || orig === fixed) return false;
  const norm = normalizeCode(content);
  return !norm.includes(orig) && norm.includes(fixed);
}

export interface MergeResult {
  toPost: ReviewFinding[];
  /** Candidates explicitly demoted by a prior safety stage. They remain visible
   *  in the review's manual-review section instead of being deleted. */
  reviewOnly: ReviewSurfaceFinding[];
  stillOpen: StoredFinding[];
  newlyFixed: StoredFinding[];
  stats: { newCount: number; fixedCount: number; openCount: number };
}

export interface MergeOptions {
  /** Candidates that a prior stage (for example repeated-run recurrence) kept
   *  for human review. They still count as seen so existing findings never flip
   *  to fixed merely because a recurrence threshold was not met. `incoming`
   *  contains only normal-surface candidates; a matching normal candidate wins
   *  over this manual copy regardless of confidence. */
  manualCandidates?: ReviewSurfaceFinding[];
  /**
   * The set of file paths ACTUALLY reviewed this run. A prior finding is only
   * eligible to be marked "fixed" (by not being re-detected) if its file was
   * reviewed. On an incremental `synchronize` push the diff — and therefore the
   * reviewed set — is only the newly-pushed files, so without this a prior P1
   * in an un-touched file would be silently marked fixed. When omitted (e.g.
   * unit tests, a full review), every file is treated as reviewed (legacy
   * behavior).
   */
  reviewedFiles?: Set<string>;
  /**
   * The head SHA of the PREVIOUS review. Used to prevent flip-flop: a finding
   * cannot go from "open" to "fixed" while the code is unchanged (same SHA).
   * This is a stable signal because reconcileFixedOnHead does not overwrite it.
   */
  priorReviewSha?: string;
  /**
   * Fingerprints that hit a transient read error during reconcileFixedOnHead.
   * They are carried forward unchanged and are NEVER marked fixed this run.
   */
  protectedFingerprints?: Set<string>;
}

const MERGE_SEV_RANK: Record<string, number> = { info: 0, P3: 1, P2: 2, P1: 3 };

function isHighSeverity(severity: string): boolean {
  return severity === 'P1' || severity === 'P2';
}

export function mergeFindings(
  incoming: ReviewFinding[],
  prior: StoredFinding[],
  headSha: string,
  opts: MergeOptions,
): MergeResult {
  const manualByFingerprint = new Map(
    (opts.manualCandidates ?? []).map((item) => [fingerprintFinding(item.finding), item]),
  );
  // Multiple NORMAL passes can describe the same fingerprint at different
  // confidence levels. Keep their strongest copy. Manual candidates stay out of
  // this map: an explicitly demoted candidate must never displace a normal
  // deterministic, sweep, or recurring finding merely because it has a higher
  // reported confidence.
  const incomingByFingerprint = new Map<string, ReviewFinding>();
  for (const f of incoming) {
    const fp = fingerprintFinding(f);
    const existing = incomingByFingerprint.get(fp);
    if (!existing || f.confidence > existing.confidence) incomingByFingerprint.set(fp, f);
  }
  // A manual candidate is still evidence that an existing finding remains seen,
  // even though it is not eligible for the normal posting surface.
  const incomingFp = new Set([...incomingByFingerprint.keys(), ...manualByFingerprint.keys()]);
  const toPost: ReviewFinding[] = [];
  const reviewOnly: ReviewSurfaceFinding[] = [];

  for (const f of incomingByFingerprint.values()) {
    const fp = fingerprintFinding(f);
    const priorOpen = prior.find((p) => p.fingerprint === fp && p.status === 'open');
    // A re-detection is enough to keep an existing finding open, but it should
    // not repeat a manual-review row that has already been posted normally.
    if (priorOpen) continue;

    toPost.push(f);
  }

  // Add manual candidates that have no normal equivalent. If the fingerprint is
  // already open, the existing finding remains visible in its normal location;
  // repeating it in the manual table would only create noise.
  for (const [fp, manual] of manualByFingerprint) {
    if (incomingByFingerprint.has(fp)) continue;
    if (prior.some((p) => p.fingerprint === fp && p.status === 'open')) continue;
    reviewOnly.push(manual);
  }

  const stillOpen: StoredFinding[] = [];
  const newlyFixed: StoredFinding[] = [];

  for (const p of prior) {
    if (p.status !== 'open') continue;
    if (opts.protectedFingerprints?.has(p.fingerprint)) {
      // Transient read error: we don't know whether it's fixed, so carry it.
      stillOpen.push({ ...p });
      continue;
    }
    if (incomingFp.has(p.fingerprint)) {
      const detected = incomingByFingerprint.get(p.fingerprint);
      let carried: StoredFinding = { ...p, lastSeenSha: headSha };
      // Re-detection may upgrade severity/message when the new report ranks higher.
      if (
        detected
        && (MERGE_SEV_RANK[detected.severity] ?? 0) > (MERGE_SEV_RANK[p.severity] ?? 0)
      ) {
        carried = {
          ...carried,
          severity: detected.severity,
          message: detected.message,
          ...(detected.suggestion !== undefined ? { suggestion: detected.suggestion } : {}),
          confidence: Math.max(carried.confidence, detected.confidence),
        };
      }
      stillOpen.push(carried);
    } else if (opts.reviewedFiles && !opts.reviewedFiles.has(p.file)) {
      // This run didn't review the finding's file (an incremental push that
      // didn't touch it), so its absence from `incoming` proves nothing —
      // carry it forward unchanged rather than falsely reporting it fixed.
      stillOpen.push({ ...p });
    } else if (opts.priorReviewSha && opts.priorReviewSha === headSha) {
      // SAME commit as the previous review — the code has NOT changed, so it
      // cannot have been fixed. The model simply didn't re-surface it this run.
      // Carry it forward; never flip a real finding to "fixed" just because a
      // re-run's dice rolled differently. (Using priorReviewSha keeps this gate
      // safe from reconcileFixedOnHead overwriting lastSeenSha.)
      stillOpen.push({ ...p });
    } else if (isHighSeverity(p.severity)) {
      // P1/P2 must not auto-close from a model miss. Only reconcileFixedOnHead's
      // fixLanded / file-deleted evidence may retire them.
      stillOpen.push({ ...p });
    } else {
      newlyFixed.push({ ...p, status: 'fixed', fixedAtSha: headSha });
    }
  }

  return {
    toPost,
    reviewOnly,
    stillOpen,
    newlyFixed,
    stats: {
      newCount: toPost.length,
      fixedCount: newlyFixed.length,
      openCount: stillOpen.length + toPost.length,
    },
  };
}

export function toStoredFinding(f: ReviewFinding, headSha: string): StoredFinding {
  const fp = fingerprintFinding(f);
  return {
    id: findingId(fp, headSha, f.line),
    fingerprint: fp,
    file: f.file,
    line: f.line,
    severity: f.severity,
    category: f.category,
    message: f.message,
    suggestion: f.suggestion,
    originalCode: f.originalCode,
    fixedCode: f.fixedCode,
    confidence: f.confidence,
    ruleId: f.ruleId,
    status: 'open',
    firstSeenSha: headSha,
    lastSeenSha: headSha,
  };
}

export async function reconcileFixedOnHead(
  prior: StoredFinding[],
  headSha: string,
  reader: FileReader,
): Promise<{ stillOpen: StoredFinding[]; newlyFixed: StoredFinding[]; readErrorFps: string[] }> {
  const stillOpen: StoredFinding[] = [];
  const newlyFixed: StoredFinding[] = [];
  const readErrorFps: string[] = [];

  for (const p of prior) {
    if (p.status !== 'open') {
      stillOpen.push(p);
      continue;
    }
    const { open, genuine, readError } = await verifyFindingOnHead(p, headSha, reader);
    if (readError) {
      readErrorFps.push(p.fingerprint);
      // Don't advance lastSeenSha — we couldn't read the file.
      stillOpen.push({ ...p });
    } else if (open && genuine) {
      // Audit rule genuinely verified the finding is still open.
      stillOpen.push({ ...p, lastSeenSha: headSha });
    } else if (open) {
      // Carried forward (LLM/semgrep), but don't advance lastSeenSha — the
      // priorReviewSha flip-flop guard in mergeFindings handles retirement.
      stillOpen.push({ ...p });
    } else {
      newlyFixed.push({ ...p, status: 'fixed', fixedAtSha: headSha });
    }
  }

  return { stillOpen, newlyFixed, readErrorFps };
}
