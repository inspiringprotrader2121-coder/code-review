import type { Octokit } from '@octokit/rest';
import type { PrRef } from './types.js';
import { isGitHubRateLimitError, withGitHubRetry } from './retry.js';

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
  return withGitHubRetry(
    () => postPullRequestReviewOnce(octokit, ref, commitSha, body, inline, event),
    {
      onRetry: (waitMs, attempt) =>
        console.warn(
          `[reviews] publish rate-limited — waiting ${Math.round(waitMs / 1000)}s then retrying (${attempt})`,
        ),
    },
  );
}

async function postPullRequestReviewOnce(
  octokit: Octokit,
  ref: PrRef,
  commitSha: string,
  body: string,
  inline: InlineReviewComment[],
  event: 'COMMENT' | 'REQUEST_CHANGES' = 'COMMENT',
): Promise<PullRequestReviewResult> {
  // Fast path: one atomic review with the summary + all inline comments. ONLY
  // this call failing may trigger the resilient fallback — if it succeeds, the
  // review is already posted and nothing below may re-post it.
  let data: { id: number; html_url: string };
  try {
    ({ data } = await octokit.rest.pulls.createReview({
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
    }));
  } catch (err) {
    // Rate limits must surface to withGitHubRetry — do not enter the resilient
    // path which could partially publish then retry the whole review.
    if (isGitHubRateLimitError(err)) throw err;
    // A single finding on a line GitHub can't map to the diff ("Line could not
    // be resolved", 422) fails the WHOLE atomic review — losing the summary and
    // every other finding. Fall back: post the summary on its own, then add the
    // inline comments individually so only the unresolvable one(s) are skipped.
    if (inline.length === 0) throw err; // nothing to salvage — a real API failure
    return await postReviewResilient(octokit, ref, commitSha, body, inline, event);
  }

  // The review posted successfully. Collecting per-comment IDs is a SEPARATE,
  // best-effort follow-up call — if it's rate-limited/5xx we must NOT re-post the
  // review (the old code shared one try, so an ID-fetch failure double-posted).
  let commentIds: Array<{ path: string; line: number; id: number }> = [];
  try {
    commentIds = await collectCommentIds(octokit, ref, inline, data.id);
  } catch (err) {
    console.warn(
      '[reviews] comment-id collection failed (review already posted):',
      (err as Error).message,
    );
  }
  return { reviewId: data.id, reviewUrl: data.html_url, commentIds };
}

/** Post the summary review, then add inline comments one-by-one, skipping any
 *  line GitHub rejects. Guarantees the review lands even with a bad anchor. */
async function postReviewResilient(
  octokit: Octokit,
  ref: PrRef,
  commitSha: string,
  body: string,
  inline: InlineReviewComment[],
  event: 'COMMENT' | 'REQUEST_CHANGES',
): Promise<PullRequestReviewResult> {
  // Summary-only review (no comments) — this must succeed or it's a real failure.
  const { data } = await octokit.rest.pulls.createReview({
    owner: ref.owner,
    repo: ref.repo,
    pull_number: ref.number,
    commit_id: commitSha,
    body,
    event,
  });

  const commentIds: Array<{ path: string; line: number; id: number }> = [];
  let skipped = 0;
  for (const c of inline) {
    try {
      const { data: cm } = await octokit.rest.pulls.createReviewComment({
        owner: ref.owner,
        repo: ref.repo,
        pull_number: ref.number,
        commit_id: commitSha,
        path: c.path,
        line: c.line,
        side: c.side ?? 'RIGHT',
        body: c.body,
      });
      commentIds.push({ path: c.path, line: c.line, id: cm.id });
    } catch {
      skipped++; // GitHub couldn't resolve this line — skip it, keep the rest
    }
  }
  if (skipped > 0) {
    console.warn(
      `[reviews] posted summary + ${commentIds.length}/${inline.length} inline (${skipped} unresolvable line(s) skipped)`,
    );
  }
  return { reviewId: data.id, reviewUrl: data.html_url, commentIds };
}

async function collectCommentIds(
  octokit: Octokit,
  ref: PrRef,
  inline: InlineReviewComment[],
  reviewId: number,
): Promise<Array<{ path: string; line: number; id: number }>> {
  const commentIds: Array<{ path: string; line: number; id: number }> = [];
  if (inline.length === 0) return commentIds;
  const { data: comments } = await octokit.rest.pulls.listReviewComments({
    owner: ref.owner,
    repo: ref.repo,
    pull_number: ref.number,
    per_page: 100,
  });
  for (const ic of inline) {
    const match = comments.find(
      (c) => c.path === ic.path && c.line === ic.line && c.pull_request_review_id === reviewId,
    );
    if (match) commentIds.push({ path: ic.path, line: ic.line, id: match.id });
  }
  return commentIds;
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
