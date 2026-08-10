import { createCheckRun } from '@orvex-review/github';
import type { ArtifactPublisher, PublicationInput } from './contracts.js';
import type { StoredFinding } from '@orvex-review/store';

export async function publishCheckRun(
  publisher: ArtifactPublisher,
  input: PublicationInput,
  scope: { tenantId: string; runId: string },
  finalFindings: StoredFinding[],
): Promise<void> {
  if (!input.config.enableCheckRuns) return;

  const { stats } = input.findings;
  const manualP1 = input.merged.reviewOnly.some(({ finding }) => finding.severity === 'P1');
  const manualAny = input.merged.reviewOnly.length > 0;
  const openP1 =
    finalFindings.some((finding) => finding.status === 'open' && finding.severity === 'P1') ||
    manualP1;
  const openAny = finalFindings.some((finding) => finding.status === 'open') || manualAny;
  const incomplete = input.skippedLenses.length > 0 || input.verificationIncomplete;
  const inconclusiveCount = input.verificationInconclusiveCount ?? 0;
  const conclusion =
    openP1 && input.policy.failCheckOnP1
      ? 'failure'
      : openAny || incomplete
        ? 'neutral'
        : 'success';
  const manualNote = manualAny
    ? ` · ${input.merged.reviewOnly.length} candidate(s) need manual review${manualP1 ? ' (incl. P1)' : ''}`
    : '';
  const verifyNote =
    inconclusiveCount > 0
      ? ` · ${inconclusiveCount} P1/P2 finding${inconclusiveCount === 1 ? '' : 's'} inconclusive`
      : input.verificationIncomplete
        ? ' · verification incomplete (NOT a full precision sign-off)'
        : '';
  const summary = `${stats.newCount} new, ${stats.fixedCount} fixed, ${stats.openCount} open${manualNote}${verifyNote}`;
  await publisher.publishArtifact(scope, `check:${input.effectiveSha}`, () =>
    createCheckRun(input.octokit, input.ref, input.effectiveSha, {
      conclusion,
      title:
        inconclusiveCount > 0
          ? 'Orvex Review (inconclusive finding)'
          : incomplete
            ? 'Orvex Review (incomplete)'
            : 'Orvex Review',
      summary: incomplete
        ? input.skippedLenses.length > 0
          ? `${summary} — ${input.skippedLenses.length} review pass(es) did not complete; NOT a full sign-off`
          : inconclusiveCount > 0
            ? `${summary} — ${inconclusiveCount} P1/P2 finding${
                inconclusiveCount === 1 ? ' remains' : 's remain'
              } visible for manual review; remaining findings were precision-gated`
            : `${summary} — precision verification did not complete; NOT a full sign-off`
        : summary,
    }),
  );
}
