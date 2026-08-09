import path from 'node:path';
import { isSensitiveRepoPath, relativeToRoot, resolveUnderRoot } from './policy.js';
import { escapeRgLiteral, grepRepository } from './search.js';

export async function findCallers(
  root: string,
  symbol: string,
  rel: string | undefined,
  maxChars: number,
): Promise<string> {
  const literal = symbol.trim();
  if (!/^[A-Za-z_$][\w$]*$/.test(literal)) return 'ERROR: invalid symbol';
  return grepRepository(root, `\\b${escapeRgLiteral(literal)}\\b`, rel, undefined, false, maxChars);
}

export async function findTests(root: string, rel: string, maxChars: number): Promise<string> {
  const resolved = resolveUnderRoot(root, rel);
  if (!resolved || isSensitiveRepoPath(relativeToRoot(root, resolved))) {
    return 'ERROR: path escapes checkout or is invalid';
  }
  const base = path
    .basename(rel)
    .replace(/\.[^.]+$/, '')
    .trim();
  if (!base) return 'ERROR: invalid source path';
  const testGlob = '**/*.{test,spec}.{ts,tsx,js,jsx,mjs,cjs}';
  return grepRepository(root, escapeRgLiteral(base), undefined, testGlob, true, maxChars);
}
