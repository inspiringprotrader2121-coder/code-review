import fs from 'node:fs';
import { loadReviewRuntimeConfig } from '@orvex-review/config';
import { redactSecrets } from '../redact.js';
import { clip } from './output.js';
import { isSensitiveRepoPath, relativeToRoot, resolveUnderRoot } from './policy.js';

export async function listDirectory(root: string, rel: string, maxChars: number): Promise<string> {
  const dir = resolveUnderRoot(root, rel || '.');
  if (!dir) return 'ERROR: path escapes checkout or is invalid';
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const lines = entries
      .slice(0, 400)
      .map(
        (entry) =>
          `${entry.isDirectory() ? 'd' : entry.isSymbolicLink() ? 'l' : 'f'} ${entry.name}`,
      )
      .join('\n');
    const more = entries.length > 400 ? `\n… (${entries.length - 400} more entries omitted)` : '';
    return clip(redactSecrets(lines + more) || '(empty)', maxChars);
  } catch (error) {
    return `ERROR: ${(error as Error).message}`;
  }
}

export async function readFile(
  root: string,
  rel: string,
  offset: number | undefined,
  limit: number | undefined,
  maxChars: number,
): Promise<string> {
  const file = resolveUnderRoot(root, rel);
  if (!file) return 'ERROR: path escapes checkout or is invalid';
  if (isSensitiveRepoPath(relativeToRoot(root, file)))
    return 'ERROR: sensitive file access is not available';

  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return 'ERROR: not a regular file';
    const maxBytes = Math.min(stat.size, loadReviewRuntimeConfig().investigateFileBytes);
    const buffer = Buffer.alloc(maxBytes);
    const descriptor = fs.openSync(file, 'r');
    try {
      const read = fs.readSync(descriptor, buffer, 0, maxBytes, 0);
      let text = redactSecrets(buffer.slice(0, read).toString('utf8'));
      const start = Math.max(0, offset ?? 0);
      const lines = text.split('\n');
      const slice = limit === undefined ? lines.slice(start) : lines.slice(start, start + limit);
      text = slice.map((line, index) => `${start + index + 1}|${line}`).join('\n');
      if (stat.size > maxBytes) text += `\n… (file truncated at ${maxBytes} bytes)`;
      return clip(text, maxChars);
    } finally {
      fs.closeSync(descriptor);
    }
  } catch (error) {
    return `ERROR: ${(error as Error).message}`;
  }
}
