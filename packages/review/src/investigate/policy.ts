import fs from 'node:fs';
import path from 'node:path';

/**
 * Resolve `rel` under `root` with symlink escape protection.
 * Returns null when the path would leave the checkout.
 */
export function resolveUnderRoot(root: string, rel: string): string | null {
  if (!rel || rel.includes('\0')) return null;
  if (path.isAbsolute(rel)) return null;

  let rootReal: string;
  try {
    rootReal = fs.realpathSync(root);
  } catch {
    return null;
  }

  const candidate = path.resolve(rootReal, rel);
  const relToRoot = path.relative(rootReal, candidate);
  if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) return null;

  try {
    const real = fs.realpathSync(candidate);
    const realRel = path.relative(rootReal, real);
    if (realRel.startsWith('..') || path.isAbsolute(realRel)) return null;
    return real;
  } catch {
    // Missing paths remain confined so tools can safely report their error.
    return candidate;
  }
}

export function relativeToRoot(root: string, resolved: string): string {
  return path.relative(fs.realpathSync(root), resolved).replace(/\\/g, '/');
}

export function isSensitiveRepoPath(rel: string): boolean {
  const normalized = rel.replace(/\\/g, '/').toLowerCase();
  const base = normalized.split('/').at(-1) ?? '';
  return (
    normalized.startsWith('.git/') ||
    normalized.includes('/.git/') ||
    base === '.env' ||
    base.startsWith('.env.') ||
    /\.(?:pem|key|p12|pfx|kdbx)$/i.test(base) ||
    /^(?:id_rsa|id_ed25519|authorized_keys)$/i.test(base)
  );
}

/** Validate a grep pattern is safe for rg (no `--` flag injection via pattern). */
export function isSafeGrepPattern(pattern: string): boolean {
  return (
    Boolean(pattern) && pattern.length <= 400 && !pattern.includes('\0') && !/^--/.test(pattern)
  );
}

export function isSafeGlob(glob: string | undefined): boolean {
  if (glob === undefined || glob === '') return true;
  return !(
    glob.length > 120 ||
    glob.includes('\0') ||
    glob.includes('\\') ||
    glob.includes('..') ||
    /^--/.test(glob)
  );
}
