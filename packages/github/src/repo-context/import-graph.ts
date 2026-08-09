const IMPORT_RE =
  /(?:import\s[^'"]*?from\s*|import\s*\(\s*|export\s[^'"]*?from\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;

const RESOLVE_SUFFIXES = [
  '',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '/index.ts',
  '/index.tsx',
  '/index.js',
];

const CODE_FILE_RE =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rb|php|java|cs|vue|svelte|sh|bash|sql|ya?ml|toml|ini|conf|tf|tfvars|hcl|properties|nginx|service)$/;
const INFRA_FILENAME_RE =
  /(^|\/)(Dockerfile(\.[A-Za-z0-9_-]+)?|docker-compose(\.[A-Za-z0-9_-]+)?\.ya?ml|Makefile|Caddyfile|Procfile|nginx\.conf|\.env\.example)$/i;
const BUILD_METADATA_RE =
  /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock)$/i;
const MIGRATION_PATH_RE = /(^|\/)migrations?\//i;
const SCHEMA_BASENAME_RE = /^(schema\.(prisma|sql|rb)|structure\.sql|[\w.-]*-?schema\.sql)$/i;

function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') parts.pop();
    else parts.push(segment);
  }
  return parts.join('/');
}

/** Relative module specifiers ('./x', '../y') referenced by a source file. */
export function parseRelativeImports(content: string): string[] {
  const specs = new Set<string>();
  for (const match of content.matchAll(IMPORT_RE)) {
    const spec = match[1];
    if (spec.startsWith('./') || spec.startsWith('../')) specs.add(spec);
  }
  return [...specs];
}

/** Resolve a relative import to a source path retained in the repository tree. */
export function resolveImportToTreePath(
  fromFile: string,
  spec: string,
  tree: Set<string>,
): string | null {
  const dir = fromFile.includes('/') ? fromFile.slice(0, fromFile.lastIndexOf('/')) : '';
  const base = normalizePath(`${dir}/${spec}`);
  const candidates = [base];
  if (/\.(js|mjs|cjs)$/.test(base)) {
    candidates.push(
      base.replace(/\.(js|mjs|cjs)$/, '.ts'),
      base.replace(/\.(js|mjs|cjs)$/, '.tsx'),
    );
  }
  for (const candidate of candidates) {
    for (const suffix of RESOLVE_SUFFIXES) {
      const full = `${candidate}${suffix}`;
      if (tree.has(full)) return full;
    }
  }
  return null;
}

export function isReviewableRepoFile(path: string): boolean {
  return CODE_FILE_RE.test(path) || INFRA_FILENAME_RE.test(path) || BUILD_METADATA_RE.test(path);
}

export function collectRelatedPaths(
  changedContents: ReadonlyArray<{ path: string; content: string }>,
  changedFiles: readonly string[],
  treePaths: readonly string[],
  tree: Set<string>,
): string[] {
  const changed = new Set(changedFiles);
  const candidates = new Set<string>();
  const paths: string[] = [];
  const add = (path: string) => {
    if (!changed.has(path) && !candidates.has(path)) {
      candidates.add(path);
      paths.push(path);
    }
  };

  for (const { path, content } of changedContents) {
    if (!isReviewableRepoFile(path)) continue;
    for (const spec of parseRelativeImports(content)) {
      const resolved = resolveImportToTreePath(path, spec, tree);
      if (resolved) add(resolved);
    }
  }

  const changedMigrations = changedFiles.filter(
    (path) => MIGRATION_PATH_RE.test(path) || path.endsWith('.sql'),
  );
  if (changedMigrations.length === 0) return paths;

  const schemaPaths = treePaths
    .filter((path) => SCHEMA_BASENAME_RE.test(path.split('/').pop() ?? ''))
    .slice(0, 4);
  const migrationDirs = new Set<string>();
  for (const path of changedMigrations) {
    const match = path.match(MIGRATION_PATH_RE);
    if (match?.index !== undefined) migrationDirs.add(path.slice(0, match.index + match[0].length));
  }
  const siblingMigrations = treePaths
    .filter(
      (path) =>
        !changed.has(path) && [...migrationDirs].some((directory) => path.startsWith(directory)),
    )
    .sort()
    .slice(-24);
  for (const path of [...schemaPaths, ...siblingMigrations]) add(path);
  return paths;
}

export function findDependentPaths(
  snapshot: Map<string, string> | null,
  changedFiles: readonly string[],
  alreadyIncluded: ReadonlySet<string>,
  tree: Set<string>,
): string[] {
  if (!snapshot) return [];
  const changed = new Set(changedFiles);
  const dependents: string[] = [];
  for (const [path, content] of snapshot) {
    if (changed.has(path) || alreadyIncluded.has(path) || !isReviewableRepoFile(path)) continue;
    for (const spec of parseRelativeImports(content)) {
      const resolved = resolveImportToTreePath(path, spec, tree);
      if (resolved && changed.has(resolved)) {
        dependents.push(path);
        break;
      }
    }
  }
  return dependents;
}
