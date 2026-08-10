import { createCappedArchiveStream, createCappedGunzip } from '@orvex-review/github';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline as streamPipeline } from 'node:stream/promises';

const TAR_BLOCK_BYTES = 512;
const MAX_METADATA_BYTES = 64 * 1024;

export interface AgentCheckoutArchiveLimits {
  readonly maxCompressedBytes: number;
  readonly maxExpandedBytes: number;
  readonly maxEntries: number;
  readonly maxFileBytes: number;
  readonly maxDepth: number;
  readonly maxPathBytes: number;
  readonly maxDirectories: number;
}

export function agentCheckoutArchiveLimits(maxCompressedBytes: number): AgentCheckoutArchiveLimits {
  const compressed = Math.max(1, Math.floor(maxCompressedBytes));
  return Object.freeze({
    maxCompressedBytes: compressed,
    maxExpandedBytes: Math.min(500 * 1024 * 1024, Math.max(32 * 1024 * 1024, compressed * 4)),
    maxEntries: 50_000,
    maxFileBytes: 32 * 1024 * 1024,
    maxDepth: 32,
    maxPathBytes: 16 * 1024 * 1024,
    maxDirectories: 100_000,
  });
}

interface TarHeader {
  readonly name: string;
  readonly mode: number;
  readonly size: number;
  readonly type: string;
}

interface ActiveEntry {
  readonly kind: 'file' | 'metadata';
  readonly type: 'pax' | 'pax-global' | 'long-name' | null;
  readonly size: number;
  remaining: number;
  padding: number;
  readonly chunks: Buffer[];
  file?: fs.FileHandle;
}

function archiveError(message: string): Error {
  return new Error(`agent checkout archive rejected: ${message}`);
}

function parseOctal(field: Buffer, label: string): number {
  const value = field.toString('ascii').replace(/\0.*$/, '').trim();
  if (!value) return 0;
  if (!/^[0-7]+$/.test(value)) throw archiveError(`${label} is not an octal value`);
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw archiveError(`${label} is unsafe`);
  return parsed;
}

function parseHeader(block: Buffer): TarHeader {
  const rawName = block.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
  const prefix = block.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
  const name = prefix ? `${prefix}/${rawName}` : rawName;
  return {
    name,
    mode: parseOctal(block.subarray(100, 108), 'entry mode'),
    size: parseOctal(block.subarray(124, 136), 'entry size'),
    type: String.fromCharCode(block[156] ?? 0),
  };
}

function archivePathSegments(value: string): string[] {
  const trimmed = value.replace(/\/+$/, '');
  if (
    !trimmed ||
    trimmed.length > 4_096 ||
    trimmed.includes('\0') ||
    trimmed.includes('\\') ||
    trimmed.startsWith('/')
  ) {
    throw archiveError('entry path is invalid');
  }
  const segments = trimmed.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw archiveError('entry path escapes the checkout');
  }
  return segments;
}

function parsePaxPath(contents: Buffer, scope: 'entry' | 'global'): string | undefined {
  let offset = 0;
  let resolved: string | undefined;
  while (offset < contents.length) {
    const separator = contents.indexOf(0x20, offset);
    if (separator <= offset) throw archiveError('PAX metadata is malformed');
    const length = Number(contents.subarray(offset, separator).toString('ascii'));
    if (
      !Number.isSafeInteger(length) ||
      length <= separator - offset + 1 ||
      offset + length > contents.length
    ) {
      throw archiveError('PAX metadata has an invalid record length');
    }
    const record = contents.subarray(separator + 1, offset + length);
    if (record.at(-1) !== 0x0a) throw archiveError('PAX metadata record is unterminated');
    const equals = record.indexOf(0x3d);
    if (equals <= 0) throw archiveError('PAX metadata record is malformed');
    const key = record.subarray(0, equals).toString('utf8');
    const value = record.subarray(equals + 1, -1).toString('utf8');
    if (
      key === 'size' ||
      key === 'linkpath' ||
      key.startsWith('GNU.sparse.') ||
      key === 'SCHILY.realsize'
    ) {
      throw archiveError(`unsupported PAX ${key} override`);
    }
    if (key === 'path') {
      if (scope === 'global') throw archiveError('global PAX path override is unsupported');
      resolved = value;
    }
    offset += length;
  }
  return resolved;
}

async function assertFreshCheckout(checkoutDir: string): Promise<void> {
  const stat = await fs.lstat(checkoutDir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw archiveError('checkout directory is not a private real directory');
  }
  if ((await fs.readdir(checkoutDir)).length !== 0)
    throw archiveError('checkout directory is not empty');
}

async function ensureDirectory(root: string, segments: readonly string[]): Promise<void> {
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      await fs.mkdir(current, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw archiveError('archive created an unsafe directory');
    await fs.chmod(current, 0o700);
  }
}

async function reserveOrvexPaths(checkoutDir: string): Promise<void> {
  const agentDir = path.join(checkoutDir, '.orvex-agentic');
  await fs.mkdir(agentDir, { mode: 0o700 });
  const stat = await fs.lstat(agentDir);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw archiveError('reserved agent directory is unsafe');
  await fs.chmod(agentDir, 0o700);
  await fs.writeFile(
    path.join(checkoutDir, '.codexignore'),
    [
      'node_modules/',
      'dist/',
      'build/',
      'out/',
      '.git/',
      'coverage/',
      '.next/',
      '.turbo/',
      '.cache/',
      'vendor/',
      '*.lock',
      'package-lock.json',
      'pnpm-lock.yaml',
      'yarn.lock',
      'Bun.lockb',
      '*.min.js',
      '*.min.css',
      '*.map',
      '*.png',
      '*.jpg',
      '*.jpeg',
      '*.gif',
      '*.webp',
      '*.woff',
      '*.woff2',
      '*.ttf',
      '*.eot',
      '*.pdf',
      '*.zip',
      '*.tar',
      '*.gz',
      '',
    ].join('\n'),
    { encoding: 'utf8', mode: 0o600, flag: 'wx' },
  );
}

async function writeAll(file: fs.FileHandle, chunk: Buffer): Promise<void> {
  let offset = 0;
  while (offset < chunk.length) {
    const { bytesWritten } = await file.write(chunk, offset, chunk.length - offset);
    if (bytesWritten < 1) throw archiveError('file write made no progress');
    offset += bytesWritten;
  }
}

/**
 * Stream a GitHub tarball, validating each entry before it is materialized.
 * The fresh checkout is private, entries are recreated with safe permissions,
 * and Orvex-reserved paths cannot be supplied by repository content.
 */
export async function extractAgentCheckoutArchive(
  data: unknown,
  checkoutDir: string,
  limits: AgentCheckoutArchiveLimits,
): Promise<void> {
  await assertFreshCheckout(checkoutDir);
  let buffered = Buffer.alloc(0);
  let current: ActiveEntry | undefined;
  let ended = false;
  let topLevel: string | undefined;
  let paxPath: string | undefined;
  let longName: string | undefined;
  let entries = 0;
  let pathBytes = 0;
  const kinds = new Map<string, 'file' | 'directory'>();
  const directories = new Set<string>();

  const rememberDirectory = (relative: string) => {
    if (directories.has(relative)) return;
    if (directories.size >= limits.maxDirectories) {
      throw archiveError('archive exceeds maximum directory count');
    }
    directories.add(relative);
  };

  const take = (count: number): Buffer => {
    const value = buffered.subarray(0, count);
    buffered = buffered.subarray(count);
    return value;
  };

  const resolvePath = (archivePath: string): string | null => {
    const segments = archivePathSegments(archivePath);
    const root = segments[0]!;
    if (!topLevel) topLevel = root;
    if (root !== topLevel) throw archiveError('archive contains more than one top-level directory');
    const relative = segments.slice(1);
    if (relative.length === 0) return null;
    if (relative.length > limits.maxDepth)
      throw archiveError('entry exceeds maximum directory depth');
    if (relative[0] === '.orvex-agentic' || relative[0] === '.codexignore') {
      throw archiveError('archive attempts to supply an Orvex-reserved path');
    }
    const normalized = relative.join('/');
    pathBytes += Buffer.byteLength(normalized);
    if (pathBytes > limits.maxPathBytes) {
      throw archiveError('archive exceeds cumulative path size');
    }
    return normalized;
  };

  const assertNewPath = (relative: string, kind: 'file' | 'directory') => {
    if (kinds.has(relative)) throw archiveError('archive contains duplicate paths');
    const parts = relative.split('/');
    let ancestor = '';
    for (let index = 0; index < parts.length - 1; index++) {
      ancestor = ancestor ? `${ancestor}/${parts[index]!}` : parts[index]!;
      if (kinds.get(ancestor) === 'file') throw archiveError('archive nests a path below a file');
    }
    if (kind === 'file' && directories.has(relative)) {
      throw archiveError('archive replaces a directory with a file');
    }
    kinds.set(relative, kind);
  };

  const finishCurrent = async () => {
    if (!current) return;
    if (current.remaining !== 0 || current.padding !== 0) return;
    if (current.file) await current.file.close();
    if (current.type === 'pax') {
      paxPath = parsePaxPath(Buffer.concat(current.chunks), 'entry');
    }
    if (current.type === 'pax-global') {
      parsePaxPath(Buffer.concat(current.chunks), 'global');
    }
    if (current.type === 'long-name') {
      longName = Buffer.concat(current.chunks)
        .toString('utf8')
        .replace(/\0.*$/, '')
        .replace(/\/+$/, '');
    }
    current = undefined;
  };

  const consumeAvailable = async (): Promise<void> => {
    for (;;) {
      if (ended) {
        if (buffered.some((value) => value !== 0))
          throw archiveError('data appears after archive terminator');
        buffered = Buffer.alloc(0);
        return;
      }
      if (!current) {
        if (buffered.length < TAR_BLOCK_BYTES) return;
        const headerBlock = take(TAR_BLOCK_BYTES);
        if (headerBlock.every((value) => value === 0)) {
          ended = true;
          continue;
        }
        entries++;
        if (entries > limits.maxEntries) throw archiveError('archive exceeds maximum entry count');
        const header = parseHeader(headerBlock);
        const metadata =
          header.type === 'x'
            ? 'pax'
            : header.type === 'g'
              ? 'pax-global'
              : header.type === 'L'
                ? 'long-name'
                : null;
        if (!metadata && header.type !== '0' && header.type !== '\0' && header.type !== '5') {
          throw archiveError(`unsupported archive entry type ${JSON.stringify(header.type)}`);
        }
        if (header.size > limits.maxFileBytes && !metadata) {
          throw archiveError('entry exceeds maximum file size');
        }
        if (metadata && header.size > MAX_METADATA_BYTES) {
          throw archiveError('metadata entry exceeds maximum size');
        }

        if (metadata) {
          current = {
            kind: 'metadata',
            type: metadata,
            size: header.size,
            remaining: header.size,
            padding: (TAR_BLOCK_BYTES - (header.size % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES,
            chunks: [],
          };
          continue;
        }

        const archivePath = paxPath ?? longName ?? header.name;
        paxPath = undefined;
        longName = undefined;
        const relative = resolvePath(archivePath);
        if (header.type === '5') {
          if (header.size !== 0) throw archiveError('directory entry has file data');
          if (relative) {
            assertNewPath(relative, 'directory');
            const segments = relative.split('/');
            await ensureDirectory(checkoutDir, segments);
            rememberDirectory(relative);
          }
          current = {
            kind: 'metadata',
            type: null,
            size: header.size,
            remaining: header.size,
            padding: (TAR_BLOCK_BYTES - (header.size % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES,
            chunks: [],
          };
          continue;
        }

        if (!relative) throw archiveError('archive root cannot be a regular file');
        assertNewPath(relative, 'file');
        const segments = relative.split('/');
        await ensureDirectory(checkoutDir, segments.slice(0, -1));
        for (let index = 1; index < segments.length; index++) {
          rememberDirectory(segments.slice(0, index).join('/'));
        }
        const destination = path.join(checkoutDir, ...segments);
        const mode = (header.mode & 0o111) !== 0 ? 0o700 : 0o600;
        const file = await fs.open(destination, 'wx', mode);
        current = {
          kind: 'file',
          type: null,
          size: header.size,
          remaining: header.size,
          padding: (TAR_BLOCK_BYTES - (header.size % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES,
          chunks: [],
          file,
        };
      }

      if (current.remaining > 0) {
        if (buffered.length === 0) return;
        const chunk = take(Math.min(current.remaining, buffered.length));
        if (current.kind === 'file') await writeAll(current.file!, chunk);
        else current.chunks.push(chunk);
        current.remaining -= chunk.length;
        if (current.remaining > 0) return;
      }
      if (current.padding > 0) {
        if (buffered.length < current.padding) return;
        take(current.padding);
        current.padding = 0;
      }
      await finishCurrent();
    }
  };

  const gunzip = createCappedGunzip(limits.maxExpandedBytes);
  let streamError: unknown;
  const streamDone = streamPipeline(
    createCappedArchiveStream(data, limits.maxCompressedBytes),
    gunzip,
  ).catch((error) => {
    streamError = error;
  });
  try {
    for await (const chunk of gunzip) {
      buffered =
        buffered.length === 0 ? Buffer.from(chunk) : Buffer.concat([buffered, Buffer.from(chunk)]);
      await consumeAvailable();
    }
    await consumeAvailable();
    if (!ended || current || buffered.length !== 0)
      throw archiveError('archive ended unexpectedly');
  } finally {
    await current?.file?.close().catch(() => undefined);
    await streamDone;
  }
  if (streamError) throw streamError;
  await reserveOrvexPaths(checkoutDir);
}
