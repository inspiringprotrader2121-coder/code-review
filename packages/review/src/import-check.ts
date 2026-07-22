import type { ReviewFinding } from './finding.js';

/**
 * Deterministic import/export mismatch check.
 *
 * Catches `const { x } = require('./m')` / `import { x } from './m'` where
 * `./m` never exports `x` — the binding is silently `undefined` and the first
 * call throws `TypeError: x is not a function`. This exact class killed PR93's
 * entire PITR-restore feature (`getFileFromR2` imported, only
 * `downloadFileFromR2` exported) and slipped past all 5 LLM review passes; a
 * mechanical class deserves a mechanical check.
 *
 * Precision over recall by design: any module whose export surface can't be
 * confidently enumerated (re-exports, spreads, `module.exports = someVar`,
 * `export * from`) is skipped entirely — this check must never be wrong.
 */

interface SourceFile {
  path: string;
  content: string;
}

interface NamedImport {
  /** original exported name being imported (not the local alias) */
  name: string;
  /** module specifier as written */
  spec: string;
  /** 1-based line of the import statement */
  line: number;
}

/** Export surfaces that make static enumeration unreliable — skip the module. */
const DYNAMIC_EXPORT_RE =
  /module\.exports\s*=\s*require\s*\(|Object\.assign\s*\(\s*(?:module\.)?exports|export\s*\*\s*from|export\s*\*\s*as\s+[A-Za-z_$][\w$]*\s+from|export\s*\{[^}]*\}\s*from|__exportStar|module\.exports\s*=\s*[A-Za-z_$][\w$]*\s*;?\s*$/m;

const RESOLVE_SUFFIXES = ['', '.js', '.ts', '.tsx', '.jsx', '.mjs', '.cjs', '/index.js', '/index.ts'];

/** posix-join a relative specifier onto the importing file's directory. */
function resolveRelative(fromPath: string, spec: string): string {
  const dir = fromPath.split('/').slice(0, -1);
  const parts = spec.split('/');
  const out = [...dir];
  for (const p of parts) {
    if (p === '' || p === '.') continue;
    if (p === '..') out.pop();
    else out.push(p);
  }
  return out.join('/');
}

function lineOfIndex(content: string, index: number): number {
  return content.slice(0, index).split('\n').length;
}

/** Extract named imports with RELATIVE specifiers from a JS/TS source. */
export function extractNamedImports(rawContent: string): NamedImport[] {
  const content = stripComments(rawContent);
  const imports: NamedImport[] = [];

  // ESM: import { a, b as c } from './x'  (also `import type {...}` — skip type-only)
  const esmRe = /import\s+(type\s+)?\{([^}]*)\}\s*from\s*['"](\.[^'"]*)['"]/g;
  for (const m of content.matchAll(esmRe)) {
    if (m[1]) continue; // type-only imports vanish at runtime
    const line = lineOfIndex(content, m.index ?? 0);
    for (const entry of m[2].split(',')) {
      const name = entry.trim().split(/\s+as\s+/)[0]?.trim();
      if (name && /^[A-Za-z_$][\w$]*$/.test(name) && name !== 'type' && !entry.trim().startsWith('type ')) {
        imports.push({ name, spec: m[3], line });
      }
    }
  }

  // CJS: const { a, b: c } = require('./x')
  const cjsRe = /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\s*\(\s*['"](\.[^'"]*)['"]\s*\)/g;
  for (const m of content.matchAll(cjsRe)) {
    const line = lineOfIndex(content, m.index ?? 0);
    for (const entry of m[1].split(',')) {
      // `a` or `a: localAlias` — the exported name is before the colon.
      const name = entry.trim().split(':')[0]?.trim();
      // skip rest/spread and nested destructuring
      if (name && /^[A-Za-z_$][\w$]*$/.test(name)) {
        imports.push({ name, spec: m[2], line });
      }
    }
  }

  return imports;
}

/**
 * Enumerate a module's named exports. Returns null when the surface can't be
 * statically trusted (dynamic patterns, spread in the exports object, or no
 * recognizable exports at all).
 */
/**
 * Strip `/* *\/` blocks and `//` line comments so comment lines inside an
 * export/import list don't swallow the identifier that follows them. The `//`
 * strip skips `://` so it never eats a `'http://…'` inside a string value.
 * (A comment line before `isJobsLeader,` in a module.exports block made the
 * parser drop that export and fire a false "not exported" P1 — real bug.)
 */
function stripComments(src: string): string {
  return src
    // blank out block comments but KEEP their newlines, so reported line
    // numbers (extractNamedImports) don't shift under a multi-line comment.
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    // line comments to EOL; `[^\n]*` keeps the newline. Skip `://`.
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

export function enumerateExports(rawContent: string): Set<string> | null {
  const content = stripComments(rawContent);
  if (DYNAMIC_EXPORT_RE.test(content)) return null;

  const names = new Set<string>();

  // CJS object literal: module.exports = { a, b: c, async d() {} }
  const moIdx = content.search(/module\.exports\s*=\s*\{/);
  if (moIdx >= 0) {
    const open = content.indexOf('{', moIdx);
    let depth = 0;
    let end = -1;
    for (let i = open; i < content.length; i++) {
      if (content[i] === '{') depth++;
      else if (content[i] === '}') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end < 0) return null; // unbalanced — don't trust it
    const body = content.slice(open + 1, end);
    if (/\.\.\./.test(body)) return null; // spread — can't enumerate
    // top-level keys only: split on commas at depth 0
    let d = 0;
    let token = '';
    const entries: string[] = [];
    for (const ch of body) {
      if (ch === '{' || ch === '(' || ch === '[') d++;
      else if (ch === '}' || ch === ')' || ch === ']') d--;
      if (ch === ',' && d === 0) {
        entries.push(token);
        token = '';
      } else token += ch;
    }
    entries.push(token);
    for (const e of entries) {
      const km = e.trim().match(/^(?:async\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)/);
      if (km) names.add(km[1]);
    }
  }

  // CJS property assignment: exports.a = / module.exports.a =
  for (const m of content.matchAll(/(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/g)) {
    names.add(m[1]);
  }

  // ESM declarations: export (async) function/class/const/let/var name
  for (const m of content.matchAll(
    /export\s+(?:async\s+)?(?:function\s*\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g,
  )) {
    names.add(m[1]);
  }
  // ESM lists: export { a, b as c }  (exported name is the alias when present)
  for (const m of content.matchAll(/export\s*\{([^}]*)\}(?!\s*from)/g)) {
    for (const entry of m[1].split(',')) {
      const parts = entry.trim().split(/\s+as\s+/);
      const exported = (parts[1] ?? parts[0])?.trim();
      if (exported && /^[A-Za-z_$][\w$]*$/.test(exported)) names.add(exported);
    }
  }
  if (/export\s+default\b/.test(content)) names.add('default');

  return names.size > 0 ? names : null;
}

/**
 * Check every named relative import in `sources` against the target module's
 * actual exports. `fetchFile` loads a repo file by path (null when absent).
 */
export async function checkImportBindings(
  sources: SourceFile[],
  fetchFile: (path: string) => Promise<string | null>,
): Promise<ReviewFinding[]> {
  const findings: ReviewFinding[] = [];
  const exportCache = new Map<string, { path: string; names: Set<string> } | null>();

  const resolveExports = async (
    fromPath: string,
    spec: string,
  ): Promise<{ path: string; names: Set<string> } | null> => {
    const base = resolveRelative(fromPath, spec);
    // TS-ESM convention: `./x.js` in source often means `./x.ts` on disk.
    const stems = base.endsWith('.js') ? [base, `${base.slice(0, -3)}.ts`] : [base];
    for (const stem of stems) {
      for (const suffix of RESOLVE_SUFFIXES) {
        const candidate = stem + suffix;
        if (exportCache.has(candidate)) {
          const hit = exportCache.get(candidate);
          if (hit) return hit;
          continue;
        }
        const content = await fetchFile(candidate);
        if (content === null) {
          exportCache.set(candidate, null);
          continue;
        }
        const names = enumerateExports(content);
        const entry = names ? { path: candidate, names } : null;
        exportCache.set(candidate, entry);
        // File exists: this is the resolution target, trust it (or give up if
        // its exports are un-enumerable) rather than trying further suffixes.
        return entry;
      }
    }
    return null;
  };

  for (const src of sources) {
    const imports = extractNamedImports(src.content);
    for (const imp of imports) {
      const target = await resolveExports(src.path, imp.spec);
      if (!target) continue; // unresolvable or un-enumerable — stay silent
      if (target.names.has(imp.name)) continue;
      const available = [...target.names].sort().slice(0, 12).join(', ');
      findings.push({
        file: src.path,
        line: imp.line,
        severity: 'P1',
        category: 'correctness',
        ruleId: 'import-export-mismatch',
        confidence: 0.97,
        sourceTier: 'deterministic',
        message:
          `\`${imp.name}\` is imported from \`${imp.spec}\` but \`${target.path}\` does not export it — ` +
          `the destructured binding is \`undefined\` and the first call throws ` +
          `\`TypeError: ${imp.name} is not a function\`, breaking every code path through it. ` +
          `Exports actually available: ${available}.`,
      });
    }
  }

  return findings;
}
