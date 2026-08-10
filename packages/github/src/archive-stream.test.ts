import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { createCappedArchiveStream, createCappedGunzip } from './archive-stream.js';
import { fetchRepoSnapshot } from './repo-context.js';

test('createCappedArchiveStream destroys the source on byte-cap abort', async () => {
  const chunks = Array.from({ length: 40 }, () => Buffer.alloc(100, 1));
  const source = Readable.from(chunks);
  let sourceDestroyCalled = false;
  const origDestroy = source.destroy.bind(source);
  source.destroy = ((err?: Error) => {
    sourceDestroyCalled = true;
    return origDestroy(err);
  }) as typeof source.destroy;

  const limiter = createCappedArchiveStream(source, 250, { idleTimeoutMs: 5_000 });
  await assert.rejects(async () => {
    for await (const _ of limiter) {
      /* drain until cap */
    }
  }, /exceeds the 250-byte cap/);
  assert.equal(sourceDestroyCalled || source.destroyed, true, 'source must be torn down on cap');
});

test('createCappedGunzip aborts when uncompressed output exceeds the budget', async () => {
  const huge = Buffer.alloc(200_000, 0);
  const compressed = gzipSync(huge);
  assert.ok(compressed.length < 2_000, 'fixture must be highly compressed');

  const gunzip = createCappedGunzip(50_000);
  await assert.rejects(
    () =>
      streamPipeline(
        Readable.from([compressed]),
        gunzip,
        new Writable({ write: (_chunk, _encoding, callback) => callback() }),
      ),
    /uncompressed|cap/i,
  );
});

test('createCappedGunzip preserves backpressure for output larger than stream buffers', async () => {
  const payload = Buffer.alloc(2 * 1024 * 1024);
  for (let index = 0; index < payload.length; index++) payload[index] = index % 251;
  const compressed = gzipSync(payload);
  const chunks: Buffer[] = [];
  const sink = new Writable({
    highWaterMark: 1,
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      setImmediate(callback);
    },
  });

  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      streamPipeline(Readable.from([compressed]), createCappedGunzip(payload.length + 1), sink),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('gunzip backpressure pipeline stalled')),
          5_000,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  assert.deepEqual(Buffer.concat(chunks), payload);
});

function tarEntry(name: string, content: Buffer): Buffer {
  const header = Buffer.alloc(512, 0);
  header.write(name.slice(0, 100), 0, 'utf8');
  header.write('0000644\0', 100, 'utf8');
  header.write(content.length.toString(8).padStart(11, '0') + '\0', 124, 'utf8');
  header.write('0', 156, 'utf8');
  header.write('ustar\0', 257, 'utf8');
  const padded = Buffer.alloc(Math.ceil(content.length / 512) * 512, 0);
  content.copy(padded);
  return Buffer.concat([header, padded]);
}

test('fetchRepoSnapshot rejects archives that expand past the uncompressed cap', async () => {
  const payload = Buffer.alloc(80_000, 65);
  const entry = tarEntry('repo-sha/bomb.txt', payload);
  const end = Buffer.alloc(1024, 0);
  const tarball = gzipSync(Buffer.concat([entry, end]));
  const octokit = {
    rest: {
      repos: {
        downloadTarballArchive: async () => ({
          data: tarball.buffer.slice(tarball.byteOffset, tarball.byteOffset + tarball.byteLength),
        }),
      },
    },
  } as never;

  await assert.rejects(
    () =>
      fetchRepoSnapshot(octokit, 'o', 'r', 'sha', {
        maxArchiveBytes: 10_000_000,
        maxUncompressedBytes: 40_000,
        maxFileBytes: 200_000,
        maxTotalBytes: 200_000,
      }),
    /uncompressed|cap|maxOutputLength|too large|RangeError/i,
  );
});
