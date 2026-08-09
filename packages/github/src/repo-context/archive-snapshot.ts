import { pipeline as streamPipeline } from 'node:stream/promises';
import type { Octokit } from '@octokit/rest';
import { createCappedArchiveStream, createCappedGunzip } from '../archive-stream.js';
import { resolveArchiveCap } from './limits.js';

export async function fetchRepoTree(
  octokit: Octokit,
  owner: string,
  repo: string,
  sha: string,
  maxPaths = 4000,
): Promise<string[]> {
  const { data } = await octokit.rest.git.getTree({ owner, repo, tree_sha: sha, recursive: '1' });
  return (data.tree ?? [])
    .filter((t) => t.type === 'blob' && typeof t.path === 'string')
    .map((t) => t.path as string)
    .slice(0, maxPaths);
}

/**
 * True when a tar entry name is a normalized, repo-relative path that is safe
 * to materialize to disk. Rejects absolute paths, any `.`/`..`/empty segment,
 * NUL, and backslashes (which Windows/case-insensitive hosts treat as
 * separators). Consumers write these names under a checkout dir and must be
 * able to trust they can't escape it.
 */
export function isSafeSnapshotPath(name: string): boolean {
  if (!name || name.length > 1024 || name.includes('\0') || name.includes('\\')) return false;
  if (name.startsWith('/')) return false;
  return !name.split('/').some((part) => part === '' || part === '.' || part === '..');
}

/**
 * Download the repo tarball at `sha` and extract it IN MEMORY into a
 * path → content map. Nothing touches the filesystem; the map is garbage
 * collected when the review job ends.
 */
export async function fetchRepoSnapshot(
  octokit: Octokit,
  owner: string,
  repo: string,
  sha: string,
  opts: {
    maxFileBytes?: number;
    maxTotalBytes?: number;
    maxArchiveBytes?: number;
    /** Uncompressed gunzip budget (zip-bomb defense). Default 500 MiB. */
    maxUncompressedBytes?: number;
  } = {},
): Promise<Map<string, string>> {
  const maxFileBytes = Math.min(resolveArchiveCap(opts.maxFileBytes, 120_000), 10_000_000);
  const maxTotalBytes = Math.min(resolveArchiveCap(opts.maxTotalBytes, 25_000_000), 500_000_000);
  const maxArchiveBytes = Math.min(
    resolveArchiveCap(opts.maxArchiveBytes, 150_000_000),
    500_000_000,
  );
  const maxUncompressedBytes = Math.min(
    resolveArchiveCap(opts.maxUncompressedBytes, 500_000_000),
    2_000_000_000,
  );

  const res = await octokit.rest.repos.downloadTarballArchive({
    owner,
    repo,
    ref: sha,
    request: { parseSuccessResponseBody: false },
  });
  const files = new Map<string, string>();
  let kept = 0;
  let pendingLongName: string | null = null;
  let buffered = Buffer.alloc(0);
  let current: {
    name: string | null;
    size: number;
    remaining: number;
    padding: number;
    collect: boolean;
    longName: boolean;
    binary: boolean;
    chunks: Buffer[];
    sample: Buffer[];
    sampleBytes: number;
  } | null = null;

  const consume = (count: number): Buffer => {
    const out = buffered.subarray(0, count);
    buffered = buffered.subarray(count);
    return out;
  };

  const finishEntry = () => {
    if (!current) return;
    const data = current.chunks.length > 0 ? Buffer.concat(current.chunks) : Buffer.alloc(0);
    if (current.longName) {
      pendingLongName = data.toString('utf8').replace(/\0.*$/, '');
    } else if (current.collect && current.name && !current.binary) {
      files.set(current.name, data.toString('utf8'));
      kept += current.size;
    }
    current = null;
  };

  const consumeAvailable = () => {
    for (;;) {
      if (!current) {
        if (buffered.length < 512) return;
        const header = consume(512);
        if (header.every((byte) => byte === 0)) return;

        const rawName = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
        const size =
          parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim(), 8) || 0;
        const typeflag = String.fromCharCode(header[156]);
        const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
        const longName = typeflag === 'L';
        let name: string | null = null;

        if (!longName && (typeflag === '0' || typeflag === '' || typeflag === '\0')) {
          const fullName = pendingLongName ?? (prefix ? `${prefix}/${rawName}` : rawName);
          pendingLongName = null;
          const slash = fullName.indexOf('/');
          const stripped = slash === -1 ? null : fullName.slice(slash + 1);
          name = stripped !== null && isSafeSnapshotPath(stripped) ? stripped : null;
        }

        current = {
          name,
          size,
          remaining: size,
          padding: (512 - (size % 512)) % 512,
          collect:
            (longName && size <= 4096) ||
            Boolean(name && size > 0 && size <= maxFileBytes && kept + size <= maxTotalBytes),
          longName,
          binary: false,
          chunks: [],
          sample: [],
          sampleBytes: 0,
        };
      }

      if (current.remaining > 0) {
        if (buffered.length === 0) return;
        const count = Math.min(current.remaining, buffered.length);
        const chunk = consume(count);
        if (current.collect) current.chunks.push(chunk);
        if (current.sampleBytes < 1000) {
          const sampleChunk = chunk.subarray(0, Math.max(0, 1000 - current.sampleBytes));
          current.sample.push(sampleChunk);
          current.sampleBytes += sampleChunk.length;
        }
        current.remaining -= count;
        if (current.remaining > 0) return;
      }

      if (current.padding > 0) {
        if (buffered.length < current.padding) return;
        consume(current.padding);
      }

      const sample = current.sample.length > 0 ? Buffer.concat(current.sample) : Buffer.alloc(0);
      current.binary = sample.includes(0);
      finishEntry();
    }
  };

  const gunzip = createCappedGunzip(maxUncompressedBytes);
  let gunzipError: unknown;
  const gunzipDone = streamPipeline(
    createCappedArchiveStream(res.data, maxArchiveBytes),
    gunzip,
  ).catch((err) => {
    gunzipError = err;
  });
  let uncompressedBytes = 0;
  try {
    for await (const chunk of gunzip) {
      uncompressedBytes += (chunk as Buffer).length;
      if (uncompressedBytes > maxUncompressedBytes) {
        const err = new Error(
          `repository archive expands past the ${maxUncompressedBytes}-byte uncompressed cap`,
        );
        gunzip.destroy(err);
        throw err;
      }
      buffered =
        buffered.length === 0 ? Buffer.from(chunk) : Buffer.concat([buffered, chunk as Buffer]);
      consumeAvailable();
    }
    consumeAvailable();
  } finally {
    await gunzipDone;
  }
  if (gunzipError) throw gunzipError;

  return files;
}
