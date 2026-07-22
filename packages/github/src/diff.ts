import type { Octokit } from '@octokit/rest';
import type { ChangedFile, DiffCoverage, PrRef } from './types.js';
import { filterChangedFiles } from './diff-filter.js';

export async function fetchCompareDiff(
  octokit: Octokit,
  owner: string,
  repo: string,
  baseSha: string,
  headSha: string,
  opts: { maxFileBytes: number; maxFiles: number; ignoreGlobs?: string[] },
): Promise<{ files: ChangedFile[]; coverage: DiffCoverage }> {
  // PAGINATE via the iterator — octokit.paginate does NOT aggregate
  // `res.data.files` for compareCommits (it only concatenates array responses),
  // so a single call silently dropped every file past the first page on a large
  // PR. GitHub caps the compare endpoint at 3000 files; log when we hit it.
  const GITHUB_COMPARE_FILE_CAP = 3000;
  const rawFiles: Array<{
    filename: string;
    status: string;
    patch?: string;
    previous_filename?: string;
  }> = [];
  let hitCap = false;
  for await (const res of octokit.paginate.iterator(octokit.rest.repos.compareCommits, {
    owner,
    repo,
    base: baseSha,
    head: headSha,
    per_page: 100,
  })) {
    const pageFiles = (res.data as { files?: typeof rawFiles }).files ?? [];
    for (const f of pageFiles) {
      if (rawFiles.length >= GITHUB_COMPARE_FILE_CAP) {
        hitCap = true;
        break;
      }
      rawFiles.push(f);
    }
    if (hitCap) break;
  }
  if (hitCap) {
    console.warn(
      `[diff] compare ${baseSha.slice(0, 7)}...${headSha.slice(0, 7)} hit GitHub's ${GITHUB_COMPARE_FILE_CAP}-file cap — diff is TRUNCATED`,
    );
  }

  const files = rawFiles.map((file) => ({
    filename: file.filename,
    status: file.status as ChangedFile['status'],
    patch: file.patch,
    previousFilename: file.previous_filename,
    truncated: false,
  }));

  return filterChangedFiles(files, opts);
}

/** Full diff + explicit coverage (what actually reached the reviewer). Prefer
 *  this in the pipeline so the review can flag an incomplete pass. */
export async function fetchPrDiffWithCoverage(
  octokit: Octokit,
  ref: PrRef,
  opts: {
    maxFileBytes: number;
    maxFiles: number;
    ignoreGlobs?: string[];
    sinceSha?: string;
    headSha?: string;
  },
): Promise<{ files: ChangedFile[]; coverage: DiffCoverage }> {
  if (opts.sinceSha && opts.headSha && opts.sinceSha !== opts.headSha) {
    return fetchCompareDiff(octokit, ref.owner, ref.repo, opts.sinceSha, opts.headSha, opts);
  }

  // PAGINATE — a single per_page:100 call silently dropped every file past the
  // first 100 on a large PR (they never reached the model or even the maxFiles
  // cap). Fetch all changed files (GitHub caps listFiles at 3000).
  const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
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

/** Back-compat: returns just the files. Callers that don't need coverage. */
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
  return (await fetchPrDiffWithCoverage(octokit, ref, opts)).files;
}
