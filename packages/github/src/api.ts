import type { Octokit } from '@octokit/rest';
import type { PrRef, PullRequestMeta } from './types.js';

export function parseRepoSlug(slug: string): { owner: string; repo: string } {
  const [owner, repo] = slug.split('/');
  if (!owner || !repo) {
    throw new Error(`Invalid repo slug: ${slug}`);
  }
  return { owner, repo };
}

export function isRepoAllowed(owner: string, repo: string, allowedRepo?: string): boolean {
  if (!allowedRepo) return true;
  const slug = `${owner}/${repo}`;
  return slug.toLowerCase() === allowedRepo.toLowerCase();
}

export function shouldSkipPr(
  pr: PullRequestMeta,
  opts: { botLogin: string; skipDependabot?: boolean; allowDraft?: boolean },
): string | null {
  // Checked first: a closed/merged PR should never spend a deep review — this
  // was a real incident (backlog jobs queued while a PR was open finally
  // running long after it was closed/merged, burning tokens for nothing).
  // NOTE: closed/merged is NEVER overridable — reviewing it is always pointless.
  if (pr.state !== 'open') return 'PR is closed';
  // Draft PRs are skipped for AUTO reviews (work-in-progress), but an explicit
  // `@orvex review` / manual trigger overrides this — the author asked for it.
  if (pr.draft && !opts.allowDraft) return 'draft PR';
  if (opts.skipDependabot !== false && pr.authorLogin === 'dependabot[bot]') {
    return 'dependabot PR';
  }
  if (pr.authorLogin === opts.botLogin) return 'self-authored PR';
  return null;
}

export async function fetchPullRequest(octokit: Octokit, ref: PrRef): Promise<PullRequestMeta> {
  const { data } = await octokit.rest.pulls.get({
    owner: ref.owner,
    repo: ref.repo,
    pull_number: ref.number,
  });

  return {
    number: data.number,
    title: data.title,
    body: data.body ?? undefined,
    headSha: data.head.sha,
    baseSha: data.base.sha,
    draft: data.draft ?? false,
    authorLogin: data.user?.login ?? 'unknown',
    htmlUrl: data.html_url,
    state: data.state,
  };
}

/** Cheap, single-purpose re-check for mid-run abort — avoids re-fetching the
 *  full PR object (diff-adjacent fields) just to ask "is it still open?". */
export async function isPrStillOpen(
  octokit: Octokit,
  ref: PrRef,
  signal?: AbortSignal,
): Promise<boolean> {
  const { data } = await octokit.rest.pulls.get({
    owner: ref.owner,
    repo: ref.repo,
    pull_number: ref.number,
    request: signal ? { signal } : undefined,
  });
  return data.state === 'open';
}

export async function postPrComment(octokit: Octokit, ref: PrRef, body: string): Promise<number> {
  const { data } = await octokit.rest.issues.createComment({
    owner: ref.owner,
    repo: ref.repo,
    issue_number: ref.number,
    body,
  });
  return data.id;
}

export async function addIssueCommentReaction(
  octokit: Octokit,
  owner: string,
  repo: string,
  commentId: number,
  content: '+1' | 'rocket' | 'eyes' | 'heart' | 'laugh',
): Promise<void> {
  await octokit.rest.reactions.createForIssueComment({
    owner,
    repo,
    comment_id: commentId,
    content,
  });
}

export { fetchPrDiff, fetchPrDiffWithCoverage, fetchCompareDiff } from './diff.js';
export { fetchFileContent, fetchRepoFile } from './content.js';
export { fetchPrLabels, hasIgnoreLabel } from './labels.js';
export {
  postPullRequestReview,
  replyToReviewComment,
  replyToIssueComment,
  type InlineReviewComment,
  type PullRequestReviewResult,
} from './reviews.js';
export { createCheckRun, type CheckConclusion } from './checks.js';
export {
  fetchInstallationMeta,
  buildGitHubInstallUrl,
  listInstallationRepos,
  userCanAccessInstallation,
  type InstallationRepo,
} from './install.js';
