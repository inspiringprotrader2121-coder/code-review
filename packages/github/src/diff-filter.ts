import { minimatch } from 'minimatch';
import type { ChangedFile, DiffCoverage } from './types.js';

const DEFAULT_SKIP_GLOBS = [
  '**/package-lock.json',
  '**/pnpm-lock.yaml',
  '**/yarn.lock',
  '**/dist/**',
  '**/build/**',
  '**/*.min.js',
  '**/*.map',
  '**/coverage/**',
];

const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.pdf',
  '.zip',
  '.gz',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.sqlite',
]);

export function filterChangedFiles(
  files: Array<{
    filename: string;
    status: ChangedFile['status'];
    patch?: string;
    previousFilename?: string;
    truncated: boolean;
  }>,
  opts: { maxFileBytes: number; maxFiles: number; ignoreGlobs?: string[] },
): { files: ChangedFile[]; coverage: DiffCoverage } {
  const ignore = [...DEFAULT_SKIP_GLOBS, ...(opts.ignoreGlobs ?? [])];
  const changed: ChangedFile[] = [];
  let candidates = 0;
  let skippedByCap = 0;
  let truncatedFiles = 0;
  let deletedFiles = 0;
  let omittedPatch = 0;

  for (const file of files) {
    if (shouldSkipFile(file.filename, ignore)) continue; // lockfiles/binaries — intentional, not a gap
    candidates += 1;
    if (file.status === 'removed') deletedFiles += 1;

    // Cap reached: COUNT the drop instead of `break`ing, so coverage is accurate
    // (we know exactly how many files went un-reviewed, not just "some").
    if (changed.length >= opts.maxFiles) {
      skippedByCap += 1;
      continue;
    }

    let patch = file.patch;
    let truncated = file.truncated;
    if (patch && patch.length > opts.maxFileBytes) {
      patch = patch.slice(0, opts.maxFileBytes) + '\n\n… [truncated for review]';
      truncated = true;
    }
    if (truncated) truncatedFiles += 1;

    // GitHub OMITS the patch for oversized files — the file changed but there is
    // nothing to review. Count it as a coverage GAP, not as reviewed (deletions
    // legitimately have no patch — nothing to review there either, but that's
    // expected, so it stays informational).
    if (file.status !== 'removed' && !patch) omittedPatch += 1;

    changed.push({
      filename: file.filename,
      status: file.status,
      patch,
      previousFilename: file.previousFilename,
      truncated,
    });
  }

  return {
    files: changed,
    coverage: {
      candidates,
      reviewed: changed.length - omittedPatch,
      skippedByCap,
      truncatedFiles,
      deletedFiles,
      omittedPatch,
      complete: skippedByCap === 0 && truncatedFiles === 0 && omittedPatch === 0,
    },
  };
}

function shouldSkipFile(filename: string, ignoreGlobs: string[]): boolean {
  const lower = filename.toLowerCase();
  for (const ext of BINARY_EXTENSIONS) {
    if (lower.endsWith(ext)) return true;
  }
  for (const glob of ignoreGlobs) {
    if (minimatch(filename, glob)) return true;
  }
  return false;
}
