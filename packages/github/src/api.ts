import type { Octokit } from '@octokit/rest';
import type { PrRef, PullRequestMeta } from './types.js';

export function parseRepoSlug(slug: string): { owner: string; repo: string } {
  const [owner, repo] = slug.split('/');
  if (!owner || !repo) {
    throw new Error(`Invalid repo slug: ${slug}`);
  }
  return { owner, repo };
}

export function isRepoAllowed(
  owner: string,
  repo: string,
  allowedRepo?: string,
): boolean {
  if (!allowedRepo) return true;
  const slug = `${owner}/${repo}`;
  return slug.toLowerCase() === allowedRepo.toLowerCase();
}

export function shouldSkipPr(
  pr: PullRequestMeta,
  opts: { botLogin: string; skipDependabot?: boolean },
): string | null {
  if (pr.draft) return 'draft PR';
  if (opts.skipDependabot !== false && pr.authorLogin === 'dependabot[bot]') {
    return 'dependabot PR';
  }
  if (pr.authorLogin === opts.botLogin) return 'self-authored PR';
  return null;
}

export async function fetchPullRequest(
  octokit: Octokit,
  ref: PrRef,
): Promise<PullRequestMeta> {
  const { data } = await octokit.rest.pulls.get({
    owner: ref.owner,
    repo: ref.repo,
    pull_number: ref.number,
  });

  return {
    number: data.number,
    title: data.title,
    headSha: data.head.sha,
    baseSha: data.base.sha,
    draft: data.draft ?? false,
    authorLogin: data.user?.login ?? 'unknown',
    htmlUrl: data.html_url,
  };
}

export async function postPrComment(
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

export { fetchPrDiff, fetchCompareDiff } from './diff.js';
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
export { fetchInstallationMeta, buildGitHubInstallUrl } from './install.js';
