import type { ReviewFinding } from '../finding.js';
import type { Verdicts, VerificationBatchResult } from './contracts.js';

const SEVERITY_RANK: Record<string, number> = { info: 0, P3: 1, P2: 2, P1: 3 };

export function applyVerdicts(
  findings: ReviewFinding[],
  parsed: Verdicts,
  confirmedCount: number = findings.length,
): VerificationBatchResult {
  const byId = new Map(parsed.verdicts.map((verdict) => [verdict.id, verdict]));
  const kept: ReviewFinding[] = [];
  const keptIndex = new Map<number, number>();
  const dropped: Array<{ finding: ReviewFinding; reason: string }> = [];
  const duplicates: Array<{ finding: ReviewFinding; of: ReviewFinding }> = [];
  const unverified: ReviewFinding[] = [];
  const pendingDuplicates: Array<{ sourceId: number; duplicateOf: number; mayEscalate: boolean }> =
    [];

  findings.forEach((finding, index) => {
    const verdict = byId.get(index);
    if (!verdict || verdict.verdict === 'unverified') {
      unverified.push(finding);
      return;
    }
    if (verdict.verdict === 'rejected') {
      dropped.push({ finding, reason: verdict.reason ?? 'rejected by verification' });
      return;
    }

    let severity = finding.severity;
    let severityReason: string | undefined;
    if (verdict.severity) {
      const proposedRank = SEVERITY_RANK[verdict.severity] ?? 0;
      const currentRank = SEVERITY_RANK[finding.severity] ?? 0;
      if (proposedRank > currentRank) {
        severity = verdict.severity;
      } else if (
        finding.severity === 'P1' &&
        verdict.severity === 'P2' &&
        typeof verdict.severityEvidence === 'string' &&
        verdict.severityEvidence.trim().length > 0
      ) {
        severity = 'P2';
        severityReason = verdict.severityEvidence.trim();
      }
    }
    const confirmed =
      severity !== finding.severity || severityReason
        ? { ...finding, severity, ...(severityReason ? { severityReason } : {}) }
        : finding;
    keptIndex.set(index, kept.length);
    kept.push(confirmed);
    if (verdict.duplicateOf !== undefined && verdict.duplicateOf !== index) {
      pendingDuplicates.push({
        sourceId: index,
        duplicateOf: verdict.duplicateOf,
        mayEscalate: index < confirmedCount,
      });
    }
  });

  const removePositions = new Set<number>();
  for (const pending of pendingDuplicates) {
    if (!keptIndex.has(pending.duplicateOf) || !keptIndex.has(pending.sourceId)) continue;
    const targetPosition = keptIndex.get(pending.duplicateOf)!;
    const sourcePosition = keptIndex.get(pending.sourceId)!;
    if (removePositions.has(targetPosition) || removePositions.has(sourcePosition)) continue;
    const target = kept[targetPosition];
    const confirmed = kept[sourcePosition];
    if (target.file !== confirmed.file) continue;
    const evidenceDemoted =
      target.severity === 'P2' &&
      Boolean(target.severityReason?.trim()) &&
      (SEVERITY_RANK[confirmed.severity] ?? 0) > SEVERITY_RANK.P2;
    if (
      pending.mayEscalate &&
      !evidenceDemoted &&
      (SEVERITY_RANK[confirmed.severity] ?? 0) > (SEVERITY_RANK[target.severity] ?? 0)
    ) {
      kept[targetPosition] = { ...target, severity: confirmed.severity };
    }
    duplicates.push({ finding: confirmed, of: kept[targetPosition] });
    removePositions.add(sourcePosition);
  }
  return {
    kept: kept.filter((_, position) => !removePositions.has(position)),
    dropped,
    duplicates,
    unverified,
  };
}
