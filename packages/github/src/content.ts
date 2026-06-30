import type { Octokit } from '@octokit/rest';

export async function fetchFileContent(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<string | null> {
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
  } catch {
    return null;
  }
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
