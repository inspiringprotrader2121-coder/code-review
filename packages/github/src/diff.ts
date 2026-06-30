import type { Octokit } from '@octokit/rest';
import type { ChangedFile, PrRef } from './types.js';
import { filterChangedFiles } from './diff-filter.js';

export async function fetchCompareDiff(
  octokit: Octokit,
  owner: string,
  repo: string,
  baseSha: string,
  headSha: string,
  opts: { maxFileBytes: number; maxFiles: number; ignoreGlobs?: string[] },
): Promise<ChangedFile[]> {
  const { data } = await octokit.rest.repos.compareCommits({
    owner,
    repo,
    base: baseSha,
    head: headSha,
  });

  const files = (data.files ?? []).map((file) => ({
    filename: file.filename,
    status: file.status as ChangedFile['status'],
    patch: file.patch,
    previousFilename: file.previous_filename,
    truncated: false,
  }));

  return filterChangedFiles(files, opts);
}

export async function fetchPrDiff(
  octokit: Octokit,
  ref: PrRef,
  opts: {
    maxFileBytes: number;
    maxFiles: number;
    ignoreGlobs?: string[];
    sinceSha?: string;
    headSha?: string;
  },
): Promise<ChangedFile[]> {
  if (opts.sinceSha && opts.headSha && opts.sinceSha !== opts.headSha) {
    return fetchCompareDiff(
      octokit,
      ref.owner,
      ref.repo,
      opts.sinceSha,
      opts.headSha,
      opts,
    );
  }

  const { data: files } = await octokit.rest.pulls.listFiles({
    owner: ref.owner,
    repo: ref.repo,
    pull_number: ref.number,
    per_page: 100,
  });

  const mapped = files.map((file) => ({
    filename: file.filename,
    status: file.status as ChangedFile['status'],
    patch: file.patch,
    previousFilename: file.previous_filename,
    truncated: false,
  }));

  return filterChangedFiles(mapped, opts);
}
