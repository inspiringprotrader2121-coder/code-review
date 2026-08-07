import { pipeline as streamPipeline } from 'node:stream/promises';
import type { Octokit } from '@octokit/rest';
import { fetchFileContent } from './content.js';
import { retrieveRelevantFiles } from './repo-index.js';
import { createCappedArchiveStream, createCappedGunzip } from './archive-stream.js';

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

// Include shell + SQL: a changed backup.sh / migration.sql was previously EXCLUDED
// from the relationship snapshot, so it got no companion context (its callers,
// sibling scripts, cron/compose refs) — a real recall gap on script/migration
// bugs. They're still reviewed when changed (they have a patch); this lets them
// pull related files too.
//
// Include infra/config too (yaml/toml/conf/Dockerfile/nginx/k8s/terraform):
// benchmark PRs 161-170 showed ~8 of 19 missed P1s were in compose/k8s/nginx
// files — e.g. "RUN_STARTUP_MIGRATIONS missing from the api service block" is
// only visible with the WHOLE compose file and sibling manifests in context,
// not a lone hunk. Reviewing infra hunks blind was a systematic P1 blind spot.
const CODE_FILE_RE =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rb|php|java|cs|vue|svelte|sh|bash|sql|ya?ml|toml|ini|conf|tf|tfvars|hcl|properties|nginx|service)$/;
// Anchored deliberately: `docker-compose[^/]*` also matched `docker-compose.env`
// — the standard `env_file:` secrets file — and `.env.[^/]*example[^/]*` matched
// `.env.example.bak`. Both would have pulled live credentials into retrieval.
const INFRA_FILENAME_RE = /(^|\/)(Dockerfile(\.[A-Za-z0-9_-]+)?|docker-compose(\.[A-Za-z0-9_-]+)?\.ya?ml|Makefile|Caddyfile|Procfile|nginx\.conf|\.env\.example)$/i;
const BUILD_METADATA_RE = /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock)$/i;
const isReviewableRepoFile = (path: string): boolean =>
  CODE_FILE_RE.test(path) || INFRA_FILENAME_RE.test(path) || BUILD_METADATA_RE.test(path);

/**
 * True when a tar entry name is a normalized, repo-relative path that is safe
 * to materialize to disk. Rejects absolute paths, any `.`/`..`/empty segment,
 * NUL, and backslashes (which Windows/case-insensitive hosts treat as
 * separators). Consumers write these names under a checkout dir and must be
 * able to trust they can't escape it.
 */
export function isSafeSnapshotPath(name: string): boolean {
  if (!name || name.length > 1024 || name.includes('\0') || name.includes('\\')) return false;
  if (name.startsWith('/')) return false;
  return !name.split('/').some((part) => part === '' || part === '.' || part === '..');
}

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
  opts: {
    maxFileBytes?: number;
    maxTotalBytes?: number;
    maxArchiveBytes?: number;
    /** Uncompressed gunzip budget (zip-bomb defense). Default 500 MiB. */
    maxUncompressedBytes?: number;
  } = {},
): Promise<Map<string, string>> {
  const positiveCap = (value: number | undefined, fallback: number): number =>
    value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
  const maxFileBytes = Math.min(positiveCap(opts.maxFileBytes, 120_000), 10_000_000);
  const maxTotalBytes = Math.min(positiveCap(opts.maxTotalBytes, 25_000_000), 500_000_000);
  const maxArchiveBytes = Math.min(positiveCap(opts.maxArchiveBytes, 150_000_000), 500_000_000);
  const maxUncompressedBytes = Math.min(positiveCap(opts.maxUncompressedBytes, 500_000_000), 2_000_000_000);

  const res = await octokit.rest.repos.downloadTarballArchive({
    owner,
    repo,
    ref: sha,
    request: { parseSuccessResponseBody: false },
  });
  const files = new Map<string, string>();
  let kept = 0;
  let pendingLongName: string | null = null;
  let buffered = Buffer.alloc(0);
  let current:
    | {
        name: string | null;
        size: number;
        remaining: number;
        padding: number;
        collect: boolean;
        longName: boolean;
        binary: boolean;
        chunks: Buffer[];
        sample: Buffer[];
        sampleBytes: number;
      }
    | null = null;

  const consume = (count: number): Buffer => {
    const out = buffered.subarray(0, count);
    buffered = buffered.subarray(count);
    return out;
  };

  const finishEntry = () => {
    if (!current) return;
    const data = current.chunks.length > 0 ? Buffer.concat(current.chunks) : Buffer.alloc(0);
    if (current.longName) {
      pendingLongName = data.toString('utf8').replace(/\0.*$/, '');
    } else if (current.collect && current.name && !current.binary) {
      files.set(current.name, data.toString('utf8'));
      kept += current.size;
    }
    current = null;
  };

  const consumeAvailable = () => {
    for (;;) {
      if (!current) {
        if (buffered.length < 512) return;
        const header = consume(512);
        if (header.every((byte) => byte === 0)) return; // end-of-archive blocks

        const rawName = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
        const size =
          parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim(), 8) || 0;
        const typeflag = String.fromCharCode(header[156]);
        const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
        const longName = typeflag === 'L';
        let name: string | null = null;

        if (!longName && (typeflag === '0' || typeflag === '' || typeflag === '\0')) {
          const fullName = pendingLongName ?? (prefix ? `${prefix}/${rawName}` : rawName);
          pendingLongName = null;
          const slash = fullName.indexOf('/');
          const stripped = slash === -1 ? null : fullName.slice(slash + 1);
          // Path-traversal guard at the SOURCE: a crafted tar entry (`../x`,
          // `a/../../x`, backslash on case-insensitive hosts) must never reach
          // the files map — downstream consumers (runtime-verify) materialize
          // these names to disk and rely on the names being repo-relative and
          // normalized. Reject any segment that is empty, '.', '..', or that
          // contains a backslash, rather than trusting the consumer to re-check.
          name =
            stripped !== null && isSafeSnapshotPath(stripped) ? stripped : null;
        }

        current = {
          name,
          size,
          remaining: size,
          padding: (512 - (size % 512)) % 512,
          collect:
            (longName && size <= 4096) ||
            Boolean(
              name &&
                size > 0 &&
                size <= maxFileBytes &&
                kept + size <= maxTotalBytes,
            ),
          longName,
          binary: false,
          chunks: [],
          sample: [],
          sampleBytes: 0,
        };
      }

      if (current.remaining > 0) {
        if (buffered.length === 0) return;
        const count = Math.min(current.remaining, buffered.length);
        const chunk = consume(count);
        if (current.collect) current.chunks.push(chunk);
        if (current.sampleBytes < 1000) {
          const sampleChunk = chunk.subarray(0, Math.max(0, 1000 - current.sampleBytes));
          current.sample.push(sampleChunk);
          current.sampleBytes += sampleChunk.length;
        }
        current.remaining -= count;
        if (current.remaining > 0) return;
      }

      if (current.padding > 0) {
        if (buffered.length < current.padding) return;
        consume(current.padding);
      }

      const sample = current.sample.length > 0 ? Buffer.concat(current.sample) : Buffer.alloc(0);
      current.binary = sample.includes(0);
      finishEntry();
    }
  };

  // Parse the gunzip stream incrementally. The old gunzipSync path materialized
  // the entire uncompressed tarball before applying caps, so a repository with a
  // small compressed archive but a huge expanded tree could exhaust worker RAM.
  // maxOutputLength + a running counter abort zip bombs that expand far past the
  // compressed archive cap.
  const gunzip = createCappedGunzip(maxUncompressedBytes);
  let gunzipError: unknown;
  const gunzipDone = streamPipeline(createCappedArchiveStream(res.data, maxArchiveBytes), gunzip).catch((err) => {
    gunzipError = err;
  });
  let uncompressedBytes = 0;
  try {
    for await (const chunk of gunzip) {
      uncompressedBytes += (chunk as Buffer).length;
      if (uncompressedBytes > maxUncompressedBytes) {
        const err = new Error(
          `repository archive expands past the ${maxUncompressedBytes}-byte uncompressed cap`,
        );
        gunzip.destroy(err);
        throw err;
      }
      buffered = buffered.length === 0 ? Buffer.from(chunk) : Buffer.concat([buffered, chunk as Buffer]);
      consumeAvailable();
    }
    consumeAvailable();
  } finally {
    await gunzipDone;
  }
  if (gunzipError) throw gunzipError;

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
  const nonNegativeInt = (value: number | undefined, fallback: number, max: number): number =>
    value !== undefined && Number.isFinite(value) && value >= 0
      ? Math.min(Math.floor(value), max)
      : fallback;
  const maxRelated = nonNegativeInt(opts.maxRelated, 8, 100);
  const maxDependents = nonNegativeInt(opts.maxDependents, 8, 100);
  const maxFileBytes = nonNegativeInt(opts.maxFileBytes, 16_000, 1_000_000);
  const maxSourceFiles = nonNegativeInt(opts.maxSourceFiles, 10, 100);
  const maxOthers = nonNegativeInt(opts.maxOthers, 0, 1_000);
  const clip = (content: string) =>
    content.length > maxFileBytes ? `${content.slice(0, maxFileBytes)}\n… (truncated)` : content;

  const changed = new Set(changedFiles);

  let snapshot: Map<string, string> | null = null;
  try {
    // The snapshot keeps files up to AT LEAST its own 120KB default, even when
    // the caller's per-file review limit is smaller. Passing the review limit
    // through verbatim regressed the small-budget callers (nightly 24KB, autofix
    // 32KB): the snapshot silently dropped every file over ~24KB, so exactly the
    // big files a reviewer needs context FROM vanished from related/dependents/
    // others. The per-file `clip` above still bounds what reaches the prompt —
    // this only controls what the snapshot is allowed to KEEP.
    snapshot = await fetchRepoSnapshot(octokit, owner, repo, sha, {
      maxFileBytes: Math.max(maxFileBytes, 120_000),
    });
  } catch {
    snapshot = null; // fall back to API-per-file below
  }

  const treePaths = snapshot ? [...snapshot.keys()] : await fetchRepoTree(octokit, owner, repo, sha);
  const tree = new Set(treePaths);

  // When a CHANGED file is missing from an otherwise-successful snapshot (omitted
  // for the total cap, a binary false-positive, or size), fall back to the GitHub
  // API so the file under review always gets its full content. Gated to changed
  // files (known to exist from the diff) so we never waste a call on a possibly
  // mis-resolved context path. Note: when a snapshot exists, `tree` is only the
  // snapshot's keys, so we can't gate on tree membership for the large files this
  // is meant to rescue — `changed` is the correct, complete signal.
  const readFile = async (path: string): Promise<string | null> => {
    if (!snapshot) return fetchFileContent(octokit, owner, repo, path, sha);
    const fromSnap = snapshot.get(path);
    if (fromSnap !== undefined) return fromSnap;
    if (changed.has(path)) return fetchFileContent(octokit, owner, repo, path, sha);
    return null; // best-effort context file absent from snapshot — skip
  };

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
    if (!isReviewableRepoFile(path)) continue;
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

  // Migration-aware context: a changed migration imports nothing and nothing
  // imports it, so the import graph gives the reviewer NOTHING to check it
  // against — yet its entire correctness is consistency with the ORM schema
  // and with what other migrations assume exists. (PR102: four fresh-install-
  // breaking column omissions in a rewritten baseline were invisible for
  // exactly this reason — the passes never saw schema.prisma or migrations
  // 013/028.) When a migration or .sql file changes, pull in the schema
  // definition files and the sibling migrations so shape mismatches are
  // checkable, not guessable.
  const MIGRATION_PATH_RE = /(^|\/)migrations?\//i;
  const changedMigrations = changedFiles.filter((p) => MIGRATION_PATH_RE.test(p) || p.endsWith('.sql'));
  if (changedMigrations.length > 0) {
    const SCHEMA_BASENAME_RE = /^(schema\.(prisma|sql|rb)|structure\.sql|[\w.-]*-?schema\.sql)$/i;
    const schemaPaths = treePaths
      .filter((p) => SCHEMA_BASENAME_RE.test(p.split('/').pop() ?? ''))
      .slice(0, 4);
    const migrationDirs = new Set<string>();
    for (const p of changedMigrations) {
      const m = p.match(MIGRATION_PATH_RE);
      if (m && m.index !== undefined) migrationDirs.add(p.slice(0, m.index + m[0].length));
    }
    const siblingMigrations = treePaths
      .filter((p) => !changed.has(p) && [...migrationDirs].some((d) => p.startsWith(d)))
      .sort() // migration names are ordered (000_, 013_, …)
      .slice(-24); // the most recent encode what the current shape must satisfy
    for (const path of [...schemaPaths, ...siblingMigrations]) {
      if (changed.has(path) || seen.has(path)) continue;
      const content = await readFile(path);
      if (!content) continue;
      seen.add(path);
      related.push({ path, content: clip(content) });
    }
  }

  // reverse deps: repo-wide scan for files importing the changed ones
  // (needs the snapshot — a per-file API scan of the whole repo is too costly)
  const dependents: RelatedFile[] = [];
  if (snapshot) {
    for (const [path, content] of snapshot) {
      if (dependents.length >= maxDependents) break;
      if (changed.has(path) || seen.has(path) || !isReviewableRepoFile(path)) continue;
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
