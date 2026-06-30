import { minimatch } from 'minimatch';
import type { Octokit } from '@octokit/rest';
import type { ChangedFile, PrRef, PullRequestMeta } from './types.js';

const DEFAULT_SKIP_GLOBS = [
  '**/package-lock.json',
  '**/pnpm-lock.yaml',
  '**/yarn.lock',
  '**/dist/**',
  '**/build/**',
  '**/*.min.js',
  '**/*.map',
  '**/coverage/**',
];

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf',
  '.zip', '.gz', '.woff', '.woff2', '.ttf', '.eot', '.sqlite',
]);

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

function shouldSkipFile(filename: string, maxBytes: number, size?: number): boolean {
  const lower = filename.toLowerCase();
  for (const ext of BINARY_EXTENSIONS) {
    if (lower.endsWith(ext)) return true;
  }
  for (const glob of DEFAULT_SKIP_GLOBS) {
    if (minimatch(filename, glob)) return true;
  }
  if (size !== undefined && size > maxBytes) return true;
  return false;
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

export async function fetchPrDiff(
  octokit: Octokit,
  ref: PrRef,
  opts: { maxFileBytes: number; maxFiles: number },
): Promise<ChangedFile[]> {
  const { data: files } = await octokit.rest.pulls.listFiles({
    owner: ref.owner,
    repo: ref.repo,
    pull_number: ref.number,
    per_page: 100,
  });

  const changed: ChangedFile[] = [];

  for (const file of files.slice(0, opts.maxFiles)) {
    if (shouldSkipFile(file.filename, opts.maxFileBytes, file.changes)) {
      continue;
    }

    let patch = file.patch;
    let truncated = false;

    if (patch && patch.length > opts.maxFileBytes) {
      patch = patch.slice(0, opts.maxFileBytes) + '\n\n… [truncated for review]';
      truncated = true;
    }

    changed.push({
      filename: file.filename,
      status: file.status as ChangedFile['status'],
      patch,
      previousFilename: file.previous_filename,
      truncated,
    });
  }

  return changed;
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
