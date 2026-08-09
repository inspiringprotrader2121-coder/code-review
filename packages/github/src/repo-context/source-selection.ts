import type { Octokit } from '@octokit/rest';
import { fetchFileContent } from '../content.js';
import type { RelatedFile } from './contracts.js';
import { clipContextFile } from './limits.js';

export function createSnapshotReader(
  octokit: Octokit,
  owner: string,
  repo: string,
  sha: string,
  snapshot: Map<string, string> | null,
  changedFiles: readonly string[],
): (path: string) => Promise<string | null> {
  const changed = new Set(changedFiles);
  return async (path: string): Promise<string | null> => {
    if (!snapshot) return fetchFileContent(octokit, owner, repo, path, sha);
    const fromSnapshot = snapshot.get(path);
    if (fromSnapshot !== undefined) return fromSnapshot;
    return changed.has(path) ? fetchFileContent(octokit, owner, repo, path, sha) : null;
  };
}

export async function selectChangedSources(
  changedFiles: readonly string[],
  maxSourceFiles: number,
  readFile: (path: string) => Promise<string | null>,
): Promise<{ included: RelatedFile[]; omitted: string[] }> {
  const included: RelatedFile[] = [];
  const omitted: string[] = [];
  for (const [index, path] of changedFiles.entries()) {
    if (index >= maxSourceFiles) {
      omitted.push(path);
      continue;
    }
    const content = await readFile(path);
    if (content) included.push({ path, content });
    else omitted.push(path);
  }
  return { included, omitted };
}

export async function selectRankedContext(
  paths: readonly string[],
  maxFiles: number,
  maxFileBytes: number,
  readFile: (path: string) => Promise<string | null>,
): Promise<{ included: RelatedFile[]; omitted: string[] }> {
  const included: RelatedFile[] = [];
  const omitted: string[] = [];
  for (const path of paths) {
    const content = await readFile(path);
    if (!content) continue;
    if (included.length >= maxFiles) {
      omitted.push(path);
      continue;
    }
    included.push({ path, content: clipContextFile(content, maxFileBytes) });
  }
  return { included, omitted };
}
