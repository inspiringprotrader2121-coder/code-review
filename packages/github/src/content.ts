import type { Octokit } from '@octokit/rest';
import { withGitHubRetry } from './retry.js';

function isNotFoundError(err: unknown): boolean {
  if (err && typeof err === 'object') {
    if ('status' in err && err.status === 404) return true;
    if ('message' in err && typeof err.message === 'string' && /\b404\b/.test(err.message))
      return true;
  }
  return false;
}

export async function fetchFileContent(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<string | null> {
  return withGitHubRetry(
    async () => {
      try {
        const { data } = await octokit.rest.repos.getContent({
          owner,
          repo,
          path,
          ref,
        });
        if (Array.isArray(data) || data.type !== 'file' || !('content' in data)) {
          return null;
        }
        return Buffer.from(data.content, data.encoding as BufferEncoding).toString('utf8');
      } catch (err) {
        // A genuine 404 means the file is gone; returning null lets callers treat it
        // as "fixed by deletion". Any other error (rate-limit, 5xx, network blip)
        // must propagate so it isn't silently mislabeled as "file missing" / fixed.
        if (isNotFoundError(err)) return null;
        throw err;
      }
    },
    {
      onRetry: (waitMs, attempt) =>
        console.warn(
          `[content] getContent rate-limited for ${path} — waiting ${Math.round(waitMs / 1000)}s (${attempt})`,
        ),
    },
  );
}

export async function fetchRepoFile(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<string | null> {
  return fetchFileContent(octokit, owner, repo, path, ref);
}
