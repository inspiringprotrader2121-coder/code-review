import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import {
  agentCheckoutArchiveLimits,
  extractAgentCheckoutArchive,
  type AgentCheckoutArchiveLimits,
} from './agent-checkout-archive.js';

interface ArchiveEntry {
  readonly name: string;
  readonly type?: string;
  readonly contents?: string | Buffer;
  readonly mode?: number;
}

function tarHeader(entry: ArchiveEntry, size: number): Buffer {
  const header = Buffer.alloc(512);
  header.write(entry.name, 0, 100, 'utf8');
  header.write((entry.mode ?? 0o644).toString(8).padStart(7, '0') + '\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
  header.write('00000000000\0', 136, 12, 'ascii');
  header.fill(0x20, 148, 156);
  header.write(entry.type ?? '0', 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return header;
}

function archive(entries: readonly ArchiveEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const contents = Buffer.from(entry.contents ?? '');
    blocks.push(tarHeader(entry, contents.length), contents);
    const padding = (512 - (contents.length % 512)) % 512;
    if (padding) blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

async function withCheckout(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orvex-checkout-archive-test-'));
  await fs.chmod(dir, 0o700);
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function limits(overrides: Partial<AgentCheckoutArchiveLimits> = {}): AgentCheckoutArchiveLimits {
  return { ...agentCheckoutArchiveLimits(1024 * 1024), ...overrides };
}

test('extracts only bounded regular files and reserves Orvex control paths', async () => {
  await withCheckout(async (dir) => {
    await extractAgentCheckoutArchive(
      archive([
        { name: 'owner-repo-sha/', type: '5' },
        { name: 'owner-repo-sha/src/', type: '5' },
        { name: 'owner-repo-sha/src/index.ts', contents: 'export const ok = true;\n' },
      ]),
      dir,
      limits(),
    );

    assert.equal(
      await fs.readFile(path.join(dir, 'src/index.ts'), 'utf8'),
      'export const ok = true;\n',
    );
    assert.equal((await fs.lstat(path.join(dir, '.orvex-agentic'))).isDirectory(), true);
    assert.match(await fs.readFile(path.join(dir, '.codexignore'), 'utf8'), /node_modules/);
  });
});

test('rejects symlink, hardlink, and special archive entries before they reach the checkout', async () => {
  for (const type of ['2', '1', '3', '4', '6']) {
    await withCheckout(async (dir) => {
      await assert.rejects(
        extractAgentCheckoutArchive(
          archive([{ name: 'owner-repo-sha/.orvex-agentic', type }]),
          dir,
          limits(),
        ),
        /unsupported archive entry type/,
      );
      assert.deepEqual(await fs.readdir(dir), []);
    });
  }
});

test('rejects archive-controlled Orvex paths and traversal paths', async () => {
  await withCheckout(async (dir) => {
    await assert.rejects(
      extractAgentCheckoutArchive(
        archive([{ name: 'owner-repo-sha/.orvex-agentic/escape', contents: 'nope' }]),
        dir,
        limits(),
      ),
      /Orvex-reserved path/,
    );
    assert.deepEqual(await fs.readdir(dir), []);
  });
  await withCheckout(async (dir) => {
    await assert.rejects(
      extractAgentCheckoutArchive(
        archive([{ name: 'owner-repo-sha/../outside', contents: 'nope' }]),
        dir,
        limits(),
      ),
      /escapes the checkout/,
    );
  });
});

test('enforces expanded byte, entry, file-size, and depth limits before materializing unbounded content', async () => {
  await withCheckout(async (dir) => {
    await assert.rejects(
      extractAgentCheckoutArchive(
        archive([{ name: 'owner-repo-sha/large.txt', contents: 'x'.repeat(2048) }]),
        dir,
        limits({ maxExpandedBytes: 1024 }),
      ),
      /uncompressed cap/,
    );
  });
  await withCheckout(async (dir) => {
    await assert.rejects(
      extractAgentCheckoutArchive(
        archive([{ name: 'owner-repo-sha/large.txt', contents: 'x'.repeat(2048) }]),
        dir,
        limits({ maxFileBytes: 1024 }),
      ),
      /maximum file size/,
    );
  });
  await withCheckout(async (dir) => {
    await assert.rejects(
      extractAgentCheckoutArchive(
        archive([
          { name: 'owner-repo-sha/a.txt', contents: 'a' },
          { name: 'owner-repo-sha/b.txt', contents: 'b' },
        ]),
        dir,
        limits({ maxEntries: 1 }),
      ),
      /maximum entry count/,
    );
  });
  await withCheckout(async (dir) => {
    await assert.rejects(
      extractAgentCheckoutArchive(
        archive([{ name: 'owner-repo-sha/a/b/c.txt', contents: 'x' }]),
        dir,
        limits({ maxDepth: 2 }),
      ),
      /maximum directory depth/,
    );
  });
});

test('bounds cumulative archive paths and generated directory nodes', async () => {
  await withCheckout(async (dir) => {
    await assert.rejects(
      extractAgentCheckoutArchive(
        archive([
          { name: 'owner-repo-sha/first-long-path.txt', contents: 'a' },
          { name: 'owner-repo-sha/second-long-path.txt', contents: 'b' },
        ]),
        dir,
        limits({ maxPathBytes: 24 }),
      ),
      /cumulative path size/,
    );
  });
  await withCheckout(async (dir) => {
    await assert.rejects(
      extractAgentCheckoutArchive(
        archive([{ name: 'owner-repo-sha/a/b/file.txt', contents: 'x' }]),
        dir,
        limits({ maxDirectories: 1 }),
      ),
      /maximum directory count/,
    );
  });
});
