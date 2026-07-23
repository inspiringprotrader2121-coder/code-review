/**
 * Lightweight, dependency-free repo index for retrieval.
 *
 * Goal: given a PR's changed files, find the files ELSEWHERE in the repo that are
 * most relevant to the change — the callers, callees, same-domain code, and files
 * that share the same identifiers — so the reviewer reasons over the relevant
 * slice of a large repo instead of the diff alone or an arbitrary file dump.
 *
 * This is a TF-IDF retriever over source *identifiers* (function/class/variable
 * names, imported symbols), which for code is a strong relevance signal and needs
 * no embedding API, no vector store, and no per-repo indexing job — it runs in
 * memory over the snapshot we already fetch. Embeddings can augment this later;
 * this is the v1 that makes cross-file review real today.
 */

// Shell + SQL included so a changed script/migration can find its textual callers
// (a file referencing "backup.sh", or a query site hitting a migrated table).
// Infra/config files (compose, k8s, nginx, terraform, Dockerfile…) are
// retrieval candidates too: benchmark PRs 161-170 showed most missed P1s were
// infra bugs whose evidence lives in a SIBLING manifest (compose service parity,
// k8s ↔ compose drift, nginx map directives) — retrieval-by-identifier-overlap
// is exactly the mechanism that surfaces those, but it was gated to code files.
const CODE_FILE_RE =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rb|php|java|cs|vue|svelte|sh|bash|sql|ya?ml|toml|ini|conf|tf|tfvars|hcl|properties|nginx|service)$/;
const INFRA_FILENAME_RE = /(^|\/)(Dockerfile[^/]*|docker-compose[^/]*|Makefile|Caddyfile|Procfile|nginx\.conf|\.env\.[^/]*example[^/]*)$/i;
const IDENT_RE = /[A-Za-z_][A-Za-z0-9_]{2,}/g;

// Language keywords + ubiquitous names carry no relevance signal — they appear
// everywhere, so they'd just add noise (and idf already down-weights them, but
// dropping them keeps the token sets small and fast). Shell + SQL keywords are
// included because .sh/.sql files ARE indexed (a changed script/migration should
// find its textual callers) — without these, every migration "matches" every
// other migration on SELECT/UPDATE.
const STOPWORDS = new Set([
  'const', 'let', 'var', 'function', 'return', 'import', 'export', 'from', 'this',
  'true', 'false', 'null', 'undefined', 'async', 'await', 'class', 'extends', 'super',
  'new', 'typeof', 'instanceof', 'void', 'delete', 'yield', 'static', 'public', 'private',
  'protected', 'readonly', 'type', 'interface', 'enum', 'namespace', 'declare', 'default',
  'string', 'number', 'boolean', 'object', 'symbol', 'bigint', 'any', 'unknown', 'never',
  'for', 'while', 'break', 'continue', 'switch', 'case', 'else', 'catch', 'throw', 'finally',
  'try', 'with', 'and', 'not', 'the', 'that', 'this', 'value', 'data', 'result', 'item',
  'index', 'name', 'args', 'props', 'params', 'options', 'opts', 'config', 'error', 'err',
  'self', 'cls', 'def', 'func', 'end', 'nil', 'none', 'true', 'false',
  // SQL
  'select', 'insert', 'update', 'create', 'alter', 'drop', 'table', 'column', 'values',
  'where', 'join', 'left', 'right', 'inner', 'outer', 'group', 'order', 'limit', 'offset',
  'having', 'union', 'primary', 'foreign', 'references', 'constraint', 'begin', 'commit',
  'rollback', 'transaction', 'integer', 'text', 'varchar', 'timestamp', 'into', 'set',
  // shell
  'echo', 'then', 'elif', 'done', 'esac', 'local', 'shift', 'exit', 'eval', 'exec',
  'source', 'printf', 'grep', 'curl', 'sudo', 'mkdir', 'chmod', 'chown',
]);

/** Split camelCase / snake_case / kebab into lowercase subtokens. */
function subtokens(ident: string): string[] {
  return ident
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

/** Identifier token set for a source file (whole idents + their subtokens). */
function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(IDENT_RE)) {
    const whole = m[0].toLowerCase();
    if (whole.length >= 3 && !STOPWORDS.has(whole)) out.add(whole);
    for (const sub of subtokens(m[0])) {
      if (sub.length >= 3 && !STOPWORDS.has(sub)) out.add(sub);
    }
  }
  return out;
}

export interface RetrievedFile {
  path: string;
  content: string;
  score: number;
}

export interface RetrieveOptions {
  /** how many files to return (default 40) */
  k?: number;
  /** clip each returned file to this many bytes (default 24_000) */
  maxFileBytes?: number;
  /** paths to skip (already included as changed / imports / dependents) */
  exclude?: Set<string>;
  /** cap identifier scan per file so a giant generated file can't dominate */
  maxScanBytes?: number;
}

/**
 * Rank the repo's code files by identifier-overlap relevance to the changed
 * files and return the top-K, clipped. TF-IDF: a file scores for each query
 * identifier it shares, weighted by that identifier's inverse document frequency
 * (rare, meaningful names like `resolveInstallation` count far more than common
 * ones), so structurally-related files rise to the top.
 */
export function retrieveRelevantFiles(
  snapshot: Map<string, string>,
  changedFiles: string[],
  opts: RetrieveOptions = {},
): RetrievedFile[] {
  const k = opts.k ?? 40;
  const maxFileBytes = opts.maxFileBytes ?? 24_000;
  const maxScanBytes = opts.maxScanBytes ?? 200_000;
  const exclude = opts.exclude ?? new Set<string>();
  const changed = new Set(changedFiles);

  // candidate documents = code files that aren't the changed files themselves
  const docs: Array<{ path: string; tokens: Set<string> }> = [];
  const df = new Map<string, number>();
  for (const [path, content] of snapshot) {
    if ((!CODE_FILE_RE.test(path) && !INFRA_FILENAME_RE.test(path)) || changed.has(path)) continue;
    const tokens = tokenize(content.slice(0, maxScanBytes));
    docs.push({ path, tokens });
    for (const t of tokens) df.set(t, (df.get(t) ?? 0) + 1);
  }
  if (docs.length === 0) return [];
  const n = docs.length;

  // query = every identifier that appears in the changed files. When a changed
  // file is MISSING from the snapshot (dropped for size/cap), fall back to its
  // PATH tokens — `src/billing/invoice.ts` still contributes billing/invoice,
  // so retrieval over a PR of huge files degrades instead of returning nothing.
  const query = new Set<string>();
  for (const cf of changedFiles) {
    const content = snapshot.get(cf);
    if (content) {
      for (const t of tokenize(content.slice(0, maxScanBytes))) query.add(t);
    } else {
      for (const segment of cf.split('/')) {
        for (const sub of subtokens(segment.replace(/\.[^.]+$/, ''))) {
          if (sub.length >= 3 && !STOPWORDS.has(sub)) query.add(sub);
        }
      }
    }
  }
  if (query.size === 0) return [];

  const scored = docs
    .filter((d) => !exclude.has(d.path))
    .map((d) => {
      let score = 0;
      for (const t of query) {
        if (d.tokens.has(t)) score += Math.log(1 + n / (df.get(t) ?? 1));
      }
      // LENGTH-NORMALIZE: a raw idf sum scales with document size — a giant file
      // matches more query terms by chance alone and crowded out small, highly
      // relevant files. sqrt dampens the size advantage without flattening it.
      return { path: d.path, score: score / Math.sqrt(d.tokens.size || 1) };
    })
    .filter((d) => d.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);

  return scored.map((s) => {
    const content = snapshot.get(s.path) ?? '';
    return {
      path: s.path,
      score: s.score,
      content:
        content.length > maxFileBytes ? `${content.slice(0, maxFileBytes)}\n… (truncated)` : content,
    };
  });
}
