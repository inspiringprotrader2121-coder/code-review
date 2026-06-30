import type { Octokit } from '@octokit/rest';
import type { PrRef } from './types.js';

export interface InlineReviewComment {
  path: string;
  line: number;
  body: string;
  side?: 'RIGHT';
}

export interface PullRequestReviewResult {
  reviewId: number;
  reviewUrl: string;
  commentIds: Array<{ path: string; line: number; id: number }>;
}

export async function postPullRequestReview(
  octokit: Octokit,
  ref: PrRef,
  commitSha: string,
  body: string,
  inline: InlineReviewComment[],
  event: 'COMMENT' | 'REQUEST_CHANGES' = 'COMMENT',
): Promise<PullRequestReviewResult> {
  const { data } = await octokit.rest.pulls.createReview({
    owner: ref.owner,
    repo: ref.repo,
    pull_number: ref.number,
    commit_id: commitSha,
    body,
    event,
    comments: inline.map((c) => ({
      path: c.path,
      line: c.line,
      side: c.side ?? 'RIGHT',
      body: c.body,
    })),
  });

  const commentIds: Array<{ path: string; line: number; id: number }> = [];

  if (inline.length > 0) {
    const { data: comments } = await octokit.rest.pulls.listReviewComments({
      owner: ref.owner,
      repo: ref.repo,
      pull_number: ref.number,
      per_page: 100,
    });
    for (const ic of inline) {
      const match = comments.find(
        (c) => c.path === ic.path && c.line === ic.line && c.pull_request_review_id === data.id,
      );
      if (match) commentIds.push({ path: ic.path, line: ic.line, id: match.id });
    }
  }

  return {
    reviewId: data.id,
    reviewUrl: data.html_url,
    commentIds,
  };
}

export async function replyToReviewComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  commentId: number,
  body: string,
): Promise<void> {
  await octokit.rest.pulls.createReplyForReviewComment({
    owner,
    repo,
    pull_number: pullNumber,
    comment_id: commentId,
    body,
  });
}

export async function replyToIssueComment(
  octokit: Octokit,
  ref: PrRef,
  body: string,
): Promise<number> {
  const { data } = await octokit.rest.issues.createComment({
    owner: ref.owner,
    repo: ref.repo,
    issue_number: ref.number,
    body,
  });
  return data.id;
}
