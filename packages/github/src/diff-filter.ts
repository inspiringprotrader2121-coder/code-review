import { minimatch } from 'minimatch';
import type { ChangedFile } from './types.js';

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
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf',
  '.zip', '.gz', '.woff', '.woff2', '.ttf', '.eot', '.sqlite',
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
): ChangedFile[] {
  const ignore = [...DEFAULT_SKIP_GLOBS, ...(opts.ignoreGlobs ?? [])];
  const changed: ChangedFile[] = [];

  for (const file of files) {
    if (changed.length >= opts.maxFiles) break;
    if (shouldSkipFile(file.filename, ignore)) continue;

    let patch = file.patch;
    let truncated = file.truncated;

    if (patch && patch.length > opts.maxFileBytes) {
      patch = patch.slice(0, opts.maxFileBytes) + '\n\n… [truncated for review]';
      truncated = true;
    }

    changed.push({
      filename: file.filename,
      status: file.status,
      patch,
      previousFilename: file.previousFilename,
      truncated,
    });
  }

  return changed;
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
