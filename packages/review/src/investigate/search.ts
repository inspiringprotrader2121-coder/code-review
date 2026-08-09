import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';
import { loadReviewRuntimeConfig } from '@orvex-review/config';
import { redactSecrets } from '../redact.js';
import { clip, redactGrepOutput } from './output.js';
import {
  isSafeGlob,
  isSafeGrepPattern,
  isSensitiveRepoPath,
  relativeToRoot,
  resolveUnderRoot,
} from './policy.js';

const execFileAsync = promisify(execFile);

export async function grepRepository(
  root: string,
  pattern: string,
  rel: string | undefined,
  glob: string | undefined,
  caseInsensitive: boolean | undefined,
  maxChars: number,
): Promise<string> {
  if (!isSafeGrepPattern(pattern)) return 'ERROR: invalid grep pattern';
  if (!isSafeGlob(glob)) return 'ERROR: invalid glob';

  let searchPath = root;
  if (rel) {
    const resolved = resolveUnderRoot(root, rel);
    if (!resolved) return 'ERROR: path escapes checkout or is invalid';
    if (isSensitiveRepoPath(relativeToRoot(root, resolved)))
      return 'ERROR: sensitive file access is not available';
    searchPath = resolved;
  }

  const args = [
    '-n',
    '--no-heading',
    '--no-config',
    '--color',
    'never',
    '--max-count',
    '40',
    '--max-filesize',
    '256K',
    '--glob',
    '!.git/**',
    '--glob',
    '!.env',
    '--glob',
    '!.env.*',
    '--glob',
    '!**/*.pem',
    '--glob',
    '!**/*.key',
    '--glob',
    '!**/*.p12',
    '--glob',
    '!**/*.pfx',
  ];
  if (caseInsensitive) args.push('-i');
  if (glob) args.push('--glob', glob);
  args.push('--', pattern, searchPath);

  try {
    const { stdout, stderr } = await execFileAsync('rg', args, {
      timeout: 12_000,
      maxBuffer: 512_000,
      env: (() => {
        const environment = loadReviewRuntimeConfig().childProcessEnvironment;
        return { PATH: environment.PATH ?? '', HOME: environment.HOME, LANG: environment.LANG };
      })(),
    });
    const output = (stdout || stderr || '(no matches)').trim() || '(no matches)';
    const rootReal = fs.realpathSync(root);
    return clip(
      redactGrepOutput(output)
        .split('\n')
        .map((line) =>
          line.startsWith(rootReal) ? line.slice(rootReal.length).replace(/^\//, '') : line,
        )
        .join('\n'),
      maxChars,
    );
  } catch (error) {
    const failed = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
    };
    if (Number(failed.code) === 1) return '(no matches)';
    if (failed.code === 'ENOENT')
      return 'ERROR: ripgrep (rg) is not installed on this worker — cannot grep';
    return clip(
      redactSecrets((failed.stdout || failed.stderr || failed.message || 'grep failed').toString()),
      maxChars,
    );
  }
}

export function escapeRgLiteral(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}
