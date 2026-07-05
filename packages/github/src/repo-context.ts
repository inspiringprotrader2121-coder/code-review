import { gunzipSync } from 'node:zlib';
import type { Octokit } from '@octokit/rest';
import { fetchFileContent } from './content.js';
import { retrieveRelevantFiles } from './repo-index.js';

export interface RelatedFile {
  path: string;
  content: string;
}

export interface RepoContext {
  /** repo file paths at the reviewed sha (capped) */
  treePaths: string[];
  /** contents of files the changed code imports — cross-file review context */
  related: RelatedFile[];
  /** files that import the changed code (reverse dependencies) */
  dependents: RelatedFile[];
  /** full contents of the changed files themselves (diff hunks lack surrounding logic) */
  changedContents: RelatedFile[];
  /** every remaining code file in the repo snapshot — true full-repo context */
  others: RelatedFile[];
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

// ——— Full-repo snapshot (in-memory only; never written to disk) ———

const CODE_FILE_RE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rb|php|java|cs|vue|svelte)$/;

/**
 * Download the repo tarball at `sha` and extract it IN MEMORY into a
 * path → content map. Nothing touches the filesystem; the map is garbage
 * collected when the review job ends.
 */
export async function fetchRepoSnapshot(
  octokit: Octokit,
  owner: string,
  repo: string,
  sha: string,
  opts: { maxFileBytes?: number; maxTotalBytes?: number } = {},
): Promise<Map<string, string>> {
  const maxFileBytes = opts.maxFileBytes ?? 120_000;
  const maxTotalBytes = opts.maxTotalBytes ?? 25_000_000;

  const res = await octokit.rest.repos.downloadTarballArchive({ owner, repo, ref: sha });
  const tarball = Buffer.from(res.data as ArrayBuffer);
  const tar = gunzipSync(tarball);

  const files = new Map<string, string>();
  let kept = 0;
  let offset = 0;
  let pendingLongName: string | null = null;

  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    offset += 512;
    const rawName = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    if (!rawName) break; // end-of-archive blocks

    const size = parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim(), 8) || 0;
    const typeflag = String.fromCharCode(header[156]);
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const dataBlocks = Math.ceil(size / 512);
    const data = tar.subarray(offset, offset + size);
    offset += dataBlocks * 512;

    if (typeflag === 'L') {
      // GNU long-name entry: the data holds the real name for the NEXT entry
      pendingLongName = data.toString('utf8').replace(/\0.*$/, '');
      continue;
    }

    let fullName = pendingLongName ?? (prefix ? `${prefix}/${rawName}` : rawName);
    pendingLongName = null;
    if (typeflag !== '0' && typeflag !== '' && typeflag !== '\0') continue; // files only
    // strip the tarball's top-level "owner-repo-sha/" directory
    const slash = fullName.indexOf('/');
    if (slash === -1) continue;
    fullName = fullName.slice(slash + 1);
    if (!fullName || size === 0 || size > maxFileBytes) continue;
    if (kept + size > maxTotalBytes) continue;
    if (data.subarray(0, Math.min(1000, data.length)).includes(0)) continue; // binary

    files.set(fullName, data.toString('utf8'));
    kept += size;
  }

  return files;
}

export interface BuildContextOptions {
  /** max imported files included (default 8) */
  maxRelated?: number;
  /** max reverse-dependency files included (default 8) */
  maxDependents?: number;
  /** max bytes kept per context file (default 16 kB) */
  maxFileBytes?: number;
  /** max changed files whose imports are chased (default 10) */
  maxSourceFiles?: number;
  /** max remaining repo code files included in full (default 0 = off) */
  maxOthers?: number;
}

/**
 * Full-repo review context, computed from an in-memory snapshot of the repo
 * at the reviewed sha:
 *  - changedContents: full text of the changed files (hunks lack the
 *    surrounding logic — e.g. a runner 200 lines below the diff)
 *  - related: files the changed code imports (callee contracts)
 *  - dependents: files that import the changed code (caller impact)
 * Falls back to per-file API fetches when the tarball is unavailable.
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
  const maxDependents = opts.maxDependents ?? 8;
  const maxFileBytes = opts.maxFileBytes ?? 16_000;
  const maxSourceFiles = opts.maxSourceFiles ?? 10;
  const maxOthers = opts.maxOthers ?? 0;
  const clip = (content: string) =>
    content.length > maxFileBytes ? `${content.slice(0, maxFileBytes)}\n… (truncated)` : content;

  const changed = new Set(changedFiles);

  let snapshot: Map<string, string> | null = null;
  try {
    snapshot = await fetchRepoSnapshot(octokit, owner, repo, sha);
  } catch {
    snapshot = null; // fall back to API-per-file below
  }

  const treePaths = snapshot ? [...snapshot.keys()] : await fetchRepoTree(octokit, owner, repo, sha);
  const tree = new Set(treePaths);

  const readFile = async (path: string): Promise<string | null> =>
    snapshot ? (snapshot.get(path) ?? null) : fetchFileContent(octokit, owner, repo, path, sha);

  // full contents of the changed files themselves
  const changedContents: RelatedFile[] = [];
  for (const file of changedFiles.slice(0, maxSourceFiles)) {
    const content = await readFile(file);
    if (content) changedContents.push({ path: file, content });
  }

  // forward deps: what the changed code imports
  const relatedPaths: string[] = [];
  const seen = new Set<string>();
  for (const { path, content } of changedContents) {
    if (relatedPaths.length >= maxRelated) break;
    if (!CODE_FILE_RE.test(path)) continue;
    for (const spec of parseRelativeImports(content)) {
      const resolved = resolveImportToTreePath(path, spec, tree);
      if (!resolved || changed.has(resolved) || seen.has(resolved)) continue;
      seen.add(resolved);
      relatedPaths.push(resolved);
      if (relatedPaths.length >= maxRelated) break;
    }
  }
  const related: RelatedFile[] = [];
  for (const path of relatedPaths) {
    const content = await readFile(path);
    if (content) related.push({ path, content: clip(content) });
  }

  // reverse deps: repo-wide scan for files importing the changed ones
  // (needs the snapshot — a per-file API scan of the whole repo is too costly)
  const dependents: RelatedFile[] = [];
  if (snapshot) {
    for (const [path, content] of snapshot) {
      if (dependents.length >= maxDependents) break;
      if (changed.has(path) || seen.has(path) || !CODE_FILE_RE.test(path)) continue;
      for (const spec of parseRelativeImports(content)) {
        const resolved = resolveImportToTreePath(path, spec, tree);
        if (resolved && changed.has(resolved)) {
          dependents.push({ path, content: clip(content) });
          seen.add(path);
          break;
        }
      }
    }
  }

  // the rest of the repo, RETRIEVED by relevance (not arbitrary order): the
  // top-K files across the whole repo whose identifiers overlap the change, so a
  // 5-line diff can surface breakage in a file it doesn't directly import. This
  // is the repo index — it lets the reviewer reason over the relevant slice of a
  // large repo without dumping (or paying to reason over) all of it.
  const others: RelatedFile[] = [];
  if (snapshot && maxOthers > 0) {
    const exclude = new Set<string>([...changed, ...seen]);
    const retrieved = retrieveRelevantFiles(snapshot, changedFiles, {
      k: maxOthers,
      maxFileBytes,
      exclude,
    });
    for (const r of retrieved) others.push({ path: r.path, content: r.content });
  }

  return { treePaths, related, dependents, changedContents, others };
}
