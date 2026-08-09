import { getReviewComment, updateReviewCommentBody } from '@orvex-review/github';
import { appliedLine, parseApplyMarker, replaceApplyLine } from '@orvex-review/review';

type Octokit = Parameters<typeof updateReviewCommentBody>[0];

/** Best-effort UI state only. Command accounting and GitHub writes remain authoritative. */
export async function setApplyButtonState(
  octokit: Octokit,
  owner: string,
  repo: string,
  commentId: number,
  makeLine: (fingerprint: string) => string,
): Promise<void> {
  try {
    const comment = await getReviewComment(octokit, owner, repo, commentId);
    if (!comment) return;
    const fingerprint = parseApplyMarker(comment.body);
    if (!fingerprint) return;
    const updated = replaceApplyLine(comment.body, makeLine(fingerprint));
    if (updated !== comment.body) {
      await updateReviewCommentBody(octokit, owner, repo, commentId, updated);
    }
  } catch {
    // Comment-button state is cosmetic; a failure must not turn into a second command.
  }
}

export function markApplyCheckboxDone(
  octokit: Octokit,
  owner: string,
  repo: string,
  commentId: number,
  commitSha: string,
): Promise<void> {
  return setApplyButtonState(octokit, owner, repo, commentId, (fp) =>
    appliedLine(fp, commitSha.slice(0, 7)),
  );
}
