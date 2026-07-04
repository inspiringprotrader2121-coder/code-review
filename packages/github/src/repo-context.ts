import type { Octokit } from '@octokit/rest';
import { fetchFileContent } from './content.js';

export interface RelatedFile {
  path: string;
  content: string;
}

export interface RepoContext {
  /** repo file paths at the reviewed sha (capped) */
  treePaths: string[];
  /** contents of files the changed code imports — cross-file review context */
  related: RelatedFile[];
}

const IMPORT_RE =
  /(?:import\s[^'"]*?from\s*|import\s*\(\s*|export\s[^'"]*?from\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;

/** Relative module specifiers ('./x', '../y') referenced by a source file. */
export function parseRelativeImports(content: string): string[] {
  const specs = new Set<string>();
  for (const m of content.matchAll(IMPORT_RE)) {
    const spec = m[1];
    if (spec.startsWith('./') || spec.startsWith('../')) specs.add(spec);
  }
  return [...specs];
}

function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

const RESOLVE_SUFFIXES = [
  '', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '/index.ts', '/index.tsx', '/index.js',
];

/**
 * Resolve a relative import from `fromFile` to a real path in the repo tree.
 * Handles extensionless imports, ESM '.js' → '.ts' source mapping, and
 * directory index files.
 */
export function resolveImportToTreePath(
  fromFile: string,
  spec: string,
  tree: Set<string>,
): string | null {
  const dir = fromFile.includes('/') ? fromFile.slice(0, fromFile.lastIndexOf('/')) : '';
  const base = normalizePath(`${dir}/${spec}`);
  const candidates = [base];
  // ESM source style: import './x.js' referring to './x.ts' on disk
  if (/\.(js|mjs|cjs)$/.test(base)) {
    candidates.push(base.replace(/\.(js|mjs|cjs)$/, '.ts'), base.replace(/\.(js|mjs|cjs)$/, '.tsx'));
  }
  for (const c of candidates) {
    for (const suffix of RESOLVE_SUFFIXES) {
      const full = `${c}${suffix}`;
      if (tree.has(full)) return full;
    }
  }
  return null;
}

export async function fetchRepoTree(
  octokit: Octokit,
  owner: string,
  repo: string,
  sha: string,
  maxPaths = 4000,
): Promise<string[]> {
  const { data } = await octokit.rest.git.getTree({ owner, repo, tree_sha: sha, recursive: '1' });
  return (data.tree ?? [])
    .filter((t) => t.type === 'blob' && typeof t.path === 'string')
    .map((t) => t.path as string)
    .slice(0, maxPaths);
}

export interface BuildContextOptions {
  /** max related files fetched (default 8) */
  maxRelated?: number;
  /** max bytes kept per related file (default 16 kB) */
  maxFileBytes?: number;
  /** max changed files whose imports are chased (default 10) */
  maxSourceFiles?: number;
}

/**
 * Cross-file review context: the repo tree plus the contents of files the
 * changed code imports. Lets the reviewer see callee signatures / invariants
 * outside the diff instead of judging hunks blind.
 */
export async function buildRepoContext(
  octokit: Octokit,
  owner: string,
  repo: string,
  sha: string,
  changedFiles: string[],
  opts: BuildContextOptions = {},
): Promise<RepoContext> {
  const maxRelated = opts.maxRelated ?? 8;
  const maxFileBytes = opts.maxFileBytes ?? 16_000;
  const maxSourceFiles = opts.maxSourceFiles ?? 10;

  const treePaths = await fetchRepoTree(octokit, owner, repo, sha);
  const tree = new Set(treePaths);
  const changed = new Set(changedFiles);

  const relatedPaths: string[] = [];
  const seen = new Set<string>();
  for (const file of changedFiles.slice(0, maxSourceFiles)) {
    if (relatedPaths.length >= maxRelated) break;
    if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(file)) continue;
    const content = await fetchFileContent(octokit, owner, repo, file, sha);
    if (!content) continue;
    for (const spec of parseRelativeImports(content)) {
      const resolved = resolveImportToTreePath(file, spec, tree);
      if (!resolved || changed.has(resolved) || seen.has(resolved)) continue;
      seen.add(resolved);
      relatedPaths.push(resolved);
      if (relatedPaths.length >= maxRelated) break;
    }
  }

  const related: RelatedFile[] = [];
  for (const path of relatedPaths) {
    const content = await fetchFileContent(octokit, owner, repo, path, sha);
    if (!content) continue;
    related.push({
      path,
      content: content.length > maxFileBytes ? `${content.slice(0, maxFileBytes)}\n… (truncated)` : content,
    });
  }

  return { treePaths, related };
}
