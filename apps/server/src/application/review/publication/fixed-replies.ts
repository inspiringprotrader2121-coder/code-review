import { formatFixedReply } from '@orvex-review/review';
import { replyToReviewComment, type createInstallationOctokit } from '@orvex-review/github';
import type { ReviewPublicationScope, StoredFinding } from '@orvex-review/store';
import type { ArtifactPublisher } from './contracts.js';

export async function publishFixedReplies(
  publisher: ArtifactPublisher,
  input: {
    scope: Omit<ReviewPublicationScope, 'artifactKey'>;
    octokit: ReturnType<typeof createInstallationOctokit>;
    owner: string;
    repo: string;
    number: number;
    effectiveSha: string;
    fixed: StoredFinding[];
  },
): Promise<void> {
  const { scope, octokit, owner, repo, number, effectiveSha, fixed } = input;
  for (const finding of fixed) {
    if (!finding.githubCommentId) continue;
    try {
      await publisher.publishArtifact(
        scope,
        `fixed-reply:${owner}/${repo}:${finding.githubCommentId}@${effectiveSha}`,
        async () => {
          await replyToReviewComment(
            octokit,
            owner,
            repo,
            number,
            finding.githubCommentId!,
            formatFixedReply(effectiveSha),
          );
        },
      );
    } catch (error) {
      console.warn(`[worker] could not reply on comment ${finding.githubCommentId}:`, error);
    }
  }
}
