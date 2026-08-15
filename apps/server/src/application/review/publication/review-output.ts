import { commandTrigger, formatReviewBody } from '@orvex-review/review';
import { postPullRequestReview } from '@orvex-review/github';
import type { ArtifactPublisher, PublicationInput } from './contracts.js';
import { buildInlineComments } from './inline-comments.js';

export async function publishReviewOutput(
  publisher: ArtifactPublisher,
  input: PublicationInput,
  scope: { tenantId: string; runId: string },
): Promise<{ reviewId: number; commentIdMap: Map<string, number> }> {
  const { inline, summaryOnly, nitpicks, stats } = input.findings;
  const summary =
    input.llmSummary ??
    (stats.fixedCount > 0
      ? `All previously reported issues appear fixed on \`${input.effectiveSha.slice(0, 7)}\`.`
      : undefined);
  const body = formatReviewBody(
    inline,
    summaryOnly,
    {
      owner: input.owner,
      repo: input.repo,
      pr: input.number,
      headSha: input.effectiveSha,
      summary,
      filesReviewed: input.filesForLlm.map((file) => file.filename),
      isDeep: input.job.deep,
      skippedLenses: input.skippedLenses.length > 0 ? input.skippedLenses : undefined,
      coverage: input.coverage.complete
        ? undefined
        : {
            reviewed: input.coverage.reviewed,
            candidates: input.coverage.candidates,
            skippedByCap: input.coverage.skippedByCap,
            truncatedFiles: input.coverage.truncatedFiles,
            omittedPatch: input.coverage.omittedPatch,
            githubCapHit: input.coverage.githubCapHit,
          },
      stillOpen: input.merged.stillOpen.map((finding) => ({
        severity: finding.severity,
        file: finding.file,
        line: finding.line,
        message: finding.message,
      })),
      trigger: commandTrigger(),
      canAutofix: input.plan.autofix,
      reviewOnly: input.merged.reviewOnly,
      verificationIncomplete: input.verificationIncomplete
        ? (input.verificationUnavailableReason ?? 'Verification did not complete for this review.')
        : undefined,
      verificationInconclusiveCount: input.verificationInconclusiveCount,
    },
    nitpicks,
  );
  const inlineComments = buildInlineComments(
    input.findings.inline,
    input.plan,
    input.reviewContextFiles,
  );
  const hasP1 = input.merged.toPost.some((finding) => finding.severity === 'P1');
  const event = hasP1 && input.policy.requestChangesOnP1 ? 'REQUEST_CHANGES' : 'COMMENT';
  const review = await publisher.publishArtifact(
    scope,
    `review:${input.installationId}:${input.owner}/${input.repo}#${input.number}@${input.effectiveSha}`,
    () =>
      postPullRequestReview(
        input.octokit,
        input.ref,
        input.effectiveSha,
        body,
        inlineComments,
        event,
      ),
  );
  const commentIdMap = new Map<string, number>();
  for (const comment of review.commentIds) {
    commentIdMap.set(`${comment.path}:${comment.line}`, comment.id);
  }

  // Summary-only findings stay in the review table. Posting them as issue
  // comments made a second, detached thread without the inline AI-agent prompt.
  return { reviewId: review.reviewId, commentIdMap };
}
