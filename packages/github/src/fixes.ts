import type { Octokit } from '@octokit/rest';
import type { PrRef } from './types.js';

export interface PrHeadInfo {
  sha: string;
  /** head branch name */
  ref: string;
  /** base branch name (merge target) */
  baseRef: string;
  /** false when the head lives in a fork we cannot push to */
  sameRepo: boolean;
  headRepoFullName: string;
  state: 'open' | 'closed';
  /** null while GitHub is still computing mergeability */
  mergeable: boolean | null;
  /** 'clean' | 'dirty' (conflicts) | 'behind' | 'blocked' | 'unstable' | 'unknown' | … */
  mergeableState: string;
}

export async function fetchPrHeadInfo(octokit: Octokit, ref: PrRef): Promise<PrHeadInfo> {
  // mergeable is computed asynchronously by GitHub; poll briefly until it settles
  let data = (await octokit.rest.pulls.get({
    owner: ref.owner,
    repo: ref.repo,
    pull_number: ref.number,
  })).data;
  for (let i = 0; i < 3 && data.mergeable === null && data.state === 'open'; i++) {
    await sleep(1200);
    data = (await octokit.rest.pulls.get({
      owner: ref.owner,
      repo: ref.repo,
      pull_number: ref.number,
    })).data;
  }
  const baseFull = `${ref.owner}/${ref.repo}`.toLowerCase();
  const headFull = (data.head.repo?.full_name ?? '').toLowerCase();
  return {
    sha: data.head.sha,
    ref: data.head.ref,
    baseRef: data.base.ref,
    sameRepo: headFull === baseFull,
    headRepoFullName: data.head.repo?.full_name ?? 'unknown',
    state: data.state as 'open' | 'closed',
    mergeable: data.mergeable ?? null,
    mergeableState: data.mergeable_state ?? 'unknown',
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface CommitFileResult {
  commitSha: string;
}

/**
 * Current tip sha of a branch, read from the git ref (strongly consistent right
 * after a commit — unlike the PR object, which lags a few seconds). Use this for
 * the between-commits concurrency check so Orvex's own commits don't trip it.
 */
export async function fetchBranchSha(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string,
): Promise<string> {
  const { data } = await octokit.rest.git.getRef({ owner, repo, ref: `heads/${branch}` });
  return data.object.sha;
}

/**
 * Commit a single-file change to the PR branch via the Contents API.
 * GitHub rejects the update with a 409 if the file's blob changed between our
 * read and write — that conflict is surfaced as `concurrent_update` so callers
 * can abort instead of overwriting someone's in-flight edit.
 */
export async function commitFileUpdate(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string,
  path: string,
  newContent: string,
  message: string,
): Promise<CommitFileResult> {
  const { data: current } = await octokit.rest.repos.getContent({ owner, repo, path, ref: branch });
  if (Array.isArray(current) || current.type !== 'file') {
    throw new Error(`cannot update ${path}: not a file on ${branch}`);
  }

  try {
    const { data } = await octokit.rest.repos.createOrUpdateFileContents({
      owner,
      repo,
      path,
      branch,
      message,
      content: Buffer.from(newContent, 'utf8').toString('base64'),
      sha: current.sha,
    });
    return { commitSha: data.commit.sha ?? '' };
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 409 || status === 422) {
      throw new Error('concurrent_update');
    }
    if (status === 403) {
      // App has contents:write in its definition but this installation hasn't
      // accepted the upgraded permission yet.
      throw new Error('contents_write_denied');
    }
    throw err;
  }
}

export interface FileChange {
  path: string;
  content: string;
}

/**
 * Commit several file changes as ONE commit, atomically. The ref update uses
 * `force: false`, so if the branch advanced since `expectedHeadSha` (a
 * concurrent push) GitHub rejects it as a non-fast-forward and NOTHING is
 * applied — the built commit is simply orphaned. This gives all-or-nothing
 * semantics: the branch never ends up half-fixed, and a concurrent edit can
 * never be overwritten.
 */
export async function commitFilesAtomic(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string,
  expectedHeadSha: string,
  files: FileChange[],
  message: string,
): Promise<CommitFileResult> {
  const { data: baseCommit } = await octokit.rest.git.getCommit({
    owner,
    repo,
    commit_sha: expectedHeadSha,
  });

  const tree: Array<{ path: string; mode: '100644'; type: 'blob'; sha: string }> = [];
  for (const f of files) {
    const { data: blob } = await octokit.rest.git.createBlob({
      owner,
      repo,
      content: Buffer.from(f.content, 'utf8').toString('base64'),
      encoding: 'base64',
    });
    tree.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
  }

  const { data: newTree } = await octokit.rest.git.createTree({
    owner,
    repo,
    base_tree: baseCommit.tree.sha,
    tree,
  });

  const { data: commit } = await octokit.rest.git.createCommit({
    owner,
    repo,
    message,
    tree: newTree.sha,
    parents: [expectedHeadSha],
  });

  try {
    await octokit.rest.git.updateRef({
      owner,
      repo,
      ref: `heads/${branch}`,
      sha: commit.sha,
      force: false, // reject if the branch moved — compare-and-swap
    });
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 422) throw new Error('branch_moved');
    if (status === 403) throw new Error('contents_write_denied');
    throw err;
  }
  return { commitSha: commit.sha };
}

export type MergeResult =
  | { status: 'merged'; sha: string }
  | { status: 'up_to_date' }
  | { status: 'conflict' };

/**
 * Merge `fromBranch` (usually the base, e.g. main) into `intoBranch` (the PR
 * head). Resolves conflicts that git can auto-merge — the common "PR is behind
 * base" case. Returns 'conflict' when git can't merge cleanly (real overlapping
 * edits) without touching anything, so the caller can escalate safely.
 */
export async function mergeBranchInto(
  octokit: Octokit,
  owner: string,
  repo: string,
  intoBranch: string,
  fromBranch: string,
): Promise<MergeResult> {
  try {
    const res = await octokit.rest.repos.merge({
      owner,
      repo,
      base: intoBranch,
      head: fromBranch,
      commit_message: `Merge ${fromBranch} into ${intoBranch} (Orvex conflict resolution)`,
    });
    // 204 = nothing to merge (already up to date); 201 = merge commit created
    if ((res.status as number) === 204 || !res.data?.sha) return { status: 'up_to_date' };
    return { status: 'merged', sha: res.data.sha };
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 409) return { status: 'conflict' };
    if (status === 403) throw new Error('contents_write_denied');
    throw err;
  }
}

export type CommentReaction = 'eyes' | 'rocket' | '+1' | 'confused';

/** Ack a command comment so the requester knows Orvex saw it. */
export async function addCommentReaction(
  octokit: Octokit,
  owner: string,
  repo: string,
  commentId: number,
  reaction: CommentReaction,
  isReviewComment: boolean,
): Promise<void> {
  try {
    if (isReviewComment) {
      await octokit.rest.reactions.createForPullRequestReviewComment({
        owner,
        repo,
        comment_id: commentId,
        content: reaction,
      });
    } else {
      await octokit.rest.reactions.createForIssueComment({
        owner,
        repo,
        comment_id: commentId,
        content: reaction,
      });
    }
  } catch {
    // reactions are best-effort
  }
}

export async function updateReviewCommentBody(
  octokit: Octokit,
  owner: string,
  repo: string,
  commentId: number,
  body: string,
): Promise<void> {
  await octokit.rest.pulls.updateReviewComment({ owner, repo, comment_id: commentId, body });
}

export async function getReviewComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  commentId: number,
): Promise<{ id: number; body: string; path: string; line?: number; inReplyTo?: number } | null> {
  try {
    const { data } = await octokit.rest.pulls.getReviewComment({
      owner,
      repo,
      comment_id: commentId,
    });
    return {
      id: data.id,
      body: data.body,
      path: data.path,
      line: data.line ?? data.original_line ?? undefined,
      inReplyTo: data.in_reply_to_id,
    };
  } catch {
    return null;
  }
}
