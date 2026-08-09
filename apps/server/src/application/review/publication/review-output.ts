import {
  applyCheckboxLine,
  commandTrigger,
  fingerprintFinding,
  formatReviewBody,
} from '@orvex-review/review';
import { postPullRequestReview, replyToIssueComment } from '@orvex-review/github';
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

  if (input.plan.autofix && summaryOnly.length > 0) {
    for (const finding of summaryOnly.slice(0, input.policy.maxUnanchoredComments)) {
      await publishUnanchoredFinding(publisher, input, scope, finding);
    }
  }
  return { reviewId: review.reviewId, commentIdMap };
}

async function publishUnanchoredFinding(
  publisher: ArtifactPublisher,
  input: PublicationInput,
  scope: { tenantId: string; runId: string },
  finding: PublicationInput['findings']['summaryOnly'][number],
): Promise<void> {
  const fingerprint = fingerprintFinding(finding);
  const parts = [
    `**${finding.severity}** · \`${finding.file}${finding.line ? `:${finding.line}` : ''}\` · \`${finding.ruleId}\``,
    '',
    finding.message,
  ];
  if (finding.fixedCode) parts.push('', '```suggestion-preview', finding.fixedCode, '```');
  parts.push('', applyCheckboxLine(fingerprint, finding.fixedCode !== undefined));
  try {
    await publisher.publishArtifact(scope, `unanchored:${input.effectiveSha}:${fingerprint}`, () =>
      replyToIssueComment(input.octokit, input.ref, parts.join('\n')),
    );
  } catch (error) {
    console.warn('[worker] unanchored-finding comment failed:', (error as Error).message);
  }
}
