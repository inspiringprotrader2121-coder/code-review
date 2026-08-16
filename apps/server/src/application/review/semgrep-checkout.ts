import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

function destinationFor(root: string, filename: string): string | null {
  if (!filename || path.isAbsolute(filename) || filename.includes('\0') || filename.includes('\\'))
    return null;
  const parts = filename.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) return null;
  const destination = path.resolve(root, ...parts);
  return destination.startsWith(`${root}${path.sep}`) ? destination : null;
}

/**
 * Materialize only the reviewed PR-head files in an isolated directory so
 * deterministic rules never inspect the worker's deployed checkout instead.
 */
export async function runAgainstHeadFiles<T>(
  filenames: readonly string[],
  readHeadFile: (filename: string) => Promise<string | null>,
  run: (paths: string[], cwd: string) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'orvex-semgrep-'));
  try {
    const paths: string[] = [];
    for (const filename of filenames) {
      const destination = destinationFor(root, filename);
      if (!destination) continue;
      try {
        const content = await readHeadFile(filename);
        if (content === null) continue;
        await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
        await writeFile(destination, content, { mode: 0o600 });
        paths.push(filename);
      } catch {
        // Semgrep is best-effort: an inaccessible PR blob must not make the
        // review scan the worker checkout or fail the entire review.
      }
    }
    return await run(paths, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
