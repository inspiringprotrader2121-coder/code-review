import { totalUsage } from '../../../review/usage-accounting.js';
import type { PublicationInput, PublicationResult } from './contracts.js';

export function createClosedPrResult(input: PublicationInput): PublicationResult {
  return {
    findingCount: 0,
    newCount: 0,
    fixedCount: 0,
    skipReason: 'pr_closed_mid_run',
    ...totalUsage(input.usage),
  };
}

export function createPublishedResult(
  input: PublicationInput,
  reviewId: number,
): PublicationResult {
  const { inputTokens, outputTokens, costUsd } = totalUsage(input.usage, input.usagePolicy);
  const verificationIncompleteReason = input.verificationIncomplete
    ? `review incomplete: verification did not complete${input.verificationUnavailableReason ? ` (${input.verificationUnavailableReason})` : ''}`
    : undefined;
  return {
    findingCount: input.findings.stats.openCount,
    newCount: input.findings.stats.newCount,
    fixedCount: input.findings.stats.fixedCount,
    reviewId,
    inputTokens,
    outputTokens,
    costUsd,
    published: true,
    incompleteReason: input.incompleteReason ?? verificationIncompleteReason,
    newFindings: input.merged.toPost.map((finding) => ({
      severity: finding.severity,
      file: finding.file,
      line: finding.line,
    })),
    deepLensesRan: input.deepLensesRan,
  };
}
