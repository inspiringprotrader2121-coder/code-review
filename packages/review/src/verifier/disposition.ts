import { fingerprintFinding, type ReviewFinding, type ReviewSurfaceFinding } from '../finding.js';
import type { VerificationDisposition, VerifiedFindings } from './contracts.js';
import {
  isHedgedRejection,
  isProtectedSourceTier,
  isWeakVerifierTier,
  shouldRescueHedgedRejection,
} from './policy.js';

export function partitionVerifiedFindings(
  toPost: ReviewFinding[],
  reviewOnly: ReviewSurfaceFinding[],
  verified: VerifiedFindings,
  options?: { verifierTier?: string },
): VerificationDisposition {
  const verifierTier = options?.verifierTier;
  if (verified.status === 'unavailable' || verified.status === 'skipped') {
    const reason =
      verified.unavailableReason ??
      (verified.status === 'skipped'
        ? 'Verification was skipped for this review.'
        : 'Verification unavailable after retries.');
    const keptPost: ReviewFinding[] = [];
    const manual: ReviewSurfaceFinding[] = [];
    for (const finding of toPost) {
      if (finding.severity === 'P1' || finding.severity === 'P2') keptPost.push(finding);
      else manual.push({ finding, reason: `${reason} Left on manual review until re-verified.` });
    }
    for (const item of reviewOnly)
      manual.push({ finding: item.finding, reason: `${item.reason} ${reason}` });
    for (const finding of verified.unverified) {
      const fingerprint = fingerprintFinding(finding);
      if (
        keptPost.some((kept) => fingerprintFinding(kept) === fingerprint) ||
        manual.some((item) => fingerprintFinding(item.finding) === fingerprint)
      )
        continue;
      if (finding.severity === 'P1' || finding.severity === 'P2') keptPost.push(finding);
      else manual.push({ finding, reason });
    }
    return {
      toPost: keptPost,
      reviewOnly: manual,
      rescued: [],
      refuted: [],
      verificationIncomplete: true,
      unavailableReason: reason,
    };
  }

  const confirmedFingerprints = new Set(toPost.map(fingerprintFinding));
  const manualByFingerprint = new Map(
    reviewOnly.map((item) => [fingerprintFinding(item.finding), item]),
  );
  const surfaced = new Map<string, ReviewSurfaceFinding>();
  const seenManual = new Set<string>();
  const result: VerificationDisposition = {
    toPost: [],
    reviewOnly: [],
    rescued: [],
    refuted: [],
    verificationIncomplete: false,
  };
  const addToReviewSurface = (item: ReviewSurfaceFinding) => {
    const fingerprint = fingerprintFinding(item.finding);
    const existing = surfaced.get(fingerprint);
    if (!existing || item.finding.confidence > existing.finding.confidence)
      surfaced.set(fingerprint, item);
    else if (!existing.reason.includes(item.reason))
      surfaced.set(fingerprint, { ...existing, reason: `${existing.reason} ${item.reason}` });
  };
  for (const finding of verified.kept) {
    const fingerprint = fingerprintFinding(finding);
    const manual = manualByFingerprint.get(fingerprint);
    if (manual) {
      seenManual.add(fingerprint);
      addToReviewSurface({ ...manual, finding });
    } else if (confirmedFingerprints.has(fingerprint)) result.toPost.push(finding);
    else
      addToReviewSurface({
        finding,
        reason: 'Verification returned this candidate outside the confirmed review set.',
      });
  }
  for (const finding of verified.unverified) {
    const fingerprint = fingerprintFinding(finding);
    const manual = manualByFingerprint.get(fingerprint);
    if (manual) seenManual.add(fingerprint);
    const reason = manual
      ? `${manual.reason} Verifier returned no usable verdict for this candidate.`
      : 'Verifier returned no usable verdict for this candidate.';
    if (
      !manual &&
      confirmedFingerprints.has(fingerprint) &&
      (finding.severity === 'P1' || finding.severity === 'P2')
    ) {
      result.toPost.push(finding);
      result.verificationIncomplete = true;
    } else addToReviewSurface({ finding, reason });
  }
  for (const dropped of verified.dropped) {
    const fingerprint = fingerprintFinding(dropped.finding);
    const manual = manualByFingerprint.get(fingerprint);
    if (manual) seenManual.add(fingerprint);
    if (
      shouldRescueHedgedRejection(dropped.finding.sourceTier, dropped.reason, verifierTier) &&
      !manual
    ) {
      result.toPost.push(dropped.finding);
      result.rescued.push(dropped);
      continue;
    }
    const peerHedge =
      isProtectedSourceTier(dropped.finding.sourceTier) &&
      isHedgedRejection(dropped.reason) &&
      !isWeakVerifierTier(verifierTier);
    const reason = manual
      ? `${manual.reason} Verifier did not confirm it: ${dropped.reason}`
      : peerHedge
        ? `Peer verifier hedged without concrete refutation (not rescued): ${dropped.reason}`
        : `Verifier did not confirm it: ${dropped.reason}`;
    addToReviewSurface({ finding: dropped.finding, reason });
    if (isProtectedSourceTier(dropped.finding.sourceTier) && !isHedgedRejection(dropped.reason))
      result.refuted.push(dropped);
  }
  for (const [fingerprint, item] of manualByFingerprint)
    if (!seenManual.has(fingerprint)) addToReviewSurface(item);
  result.reviewOnly = [...surfaced.values()];
  if (verified.status === 'partial') {
    result.verificationIncomplete = true;
    result.unavailableReason =
      verified.unavailableReason ?? 'one or more verification batches failed';
  }
  return result;
}
