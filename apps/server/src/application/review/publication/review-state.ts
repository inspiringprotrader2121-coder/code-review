import { fingerprintFinding, toStoredFinding } from '@orvex-review/review';
import type { PrReviewState, StoredFinding } from '@orvex-review/store';
import type { PublicationInput } from './contracts.js';

export function serializeReviewState(
  input: PublicationInput,
  commentIdMap: Map<string, number>,
): { state: PrReviewState; finalFindings: StoredFinding[] } {
  const { allFixed } = input.findings;
  const newStored: StoredFinding[] = input.merged.toPost.map((finding) => {
    const stored = toStoredFinding(finding, input.effectiveSha);
    const key = finding.line ? `${finding.file}:${finding.line}` : null;
    if (key && commentIdMap.has(key)) stored.githubCommentId = commentIdMap.get(key);
    return stored;
  });

  const fixedFingerprints = new Set(allFixed.map((finding) => finding.fingerprint));
  const incomingFingerprints = new Set(
    input.merged.toPost.map((finding) => fingerprintFinding(finding)),
  );
  const updatedPrior = (input.priorState?.findings ?? []).map((stored) => {
    const fixed = allFixed.find((finding) => finding.fingerprint === stored.fingerprint);
    if (fixed) return fixed;
    const stillOpen = input.merged.stillOpen.find(
      (finding) => finding.fingerprint === stored.fingerprint,
    );
    if (stillOpen) return stillOpen;
    if (stored.status === 'fixed' && incomingFingerprints.has(stored.fingerprint)) {
      const reborn = input.merged.toPost.find(
        (finding) => fingerprintFinding(finding) === stored.fingerprint,
      );
      if (reborn) {
        return {
          ...toStoredFinding(reborn, input.effectiveSha),
          status: 'open' as const,
          firstSeenSha: stored.firstSeenSha,
        };
      }
    }
    if (fixedFingerprints.has(stored.fingerprint)) {
      return { ...stored, status: 'fixed' as const, fixedAtSha: input.effectiveSha };
    }
    return stored;
  });

  const knownFingerprints = new Set(updatedPrior.map((finding) => finding.fingerprint));
  const finalFindings = [
    ...updatedPrior,
    ...newStored.filter((finding) => !knownFingerprints.has(finding.fingerprint)),
  ];
  const manualReview = input.merged.reviewOnly.map(({ finding }) =>
    toStoredFinding(finding, input.effectiveSha),
  );
  return {
    finalFindings,
    state: {
      installationId: input.installationId,
      tenantId: input.tenantId,
      owner: input.owner,
      repo: input.repo,
      pr: input.number,
      lastSha: input.effectiveSha,
      findings: finalFindings,
      manualReview,
      lastReviewAt: new Date().toISOString(),
      codexThreadId: input.codexThreadId,
    },
  };
}
