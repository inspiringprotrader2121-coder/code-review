import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { fetchRepoSnapshot, buildRepoContext } from './repo-context.js';

// Regression tests for the 120KB snapshot hole (Codex, 2026-07-16): the snapshot
// silently dropped files over its 120KB default and readFile did not fall back to
// GitHub, so a changed file in the 120-250KB range got NO full content — making
// the advertised 250KB context ineffective.

/** Build one 512-byte tar header + padded data for a plain file. The custom
 *  parser in repo-context reads name(0-100), size(124-136 octal), typeflag(156);
 *  it does not verify the checksum, so we can omit it. */
function tarEntry(name: string, content: string): Buffer {
  const data = Buffer.from(content, 'utf8');
  const header = Buffer.alloc(512, 0);
  header.write(name.slice(0, 100), 0, 'utf8');
  header.write('0000644\0', 100, 'utf8'); // mode
  header.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 'utf8'); // size (octal)
  header.write('0', 156, 'utf8'); // typeflag: regular file
  header.write('ustar\0', 257, 'utf8');
  const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512, 0);
  data.copy(padded);
  return Buffer.concat([header, padded]);
}
function makeTarball(files: Record<string, string>): Buffer {
  const entries = Object.entries(files).map(([name, c]) => tarEntry(`repo-sha/${name}`, c));
  const end = Buffer.alloc(1024, 0); // two zero blocks = end of archive
  return gzipSync(Buffer.concat([...entries, end]));
}

const bigContent = 'const bigModule = () => {\n' + 'x'.repeat(150_000) + '\n};\n'; // ~150KB

function fakeOctokit(tarball: Buffer, getContentBody?: string) {
  return {
    rest: {
      repos: {
        downloadTarballArchive: async () => ({ data: tarball.buffer.slice(tarball.byteOffset, tarball.byteOffset + tarball.byteLength) }),
        getContent: async () =>
          getContentBody !== undefined
            ? { data: { type: 'file', content: Buffer.from(getContentBody, 'utf8').toString('base64'), encoding: 'base64' } }
            : (() => { throw new Error('getContent not stubbed'); })(),
      },
    },
    // paginate isn't used on the snapshot path
  } as never;
}

test('fetchRepoSnapshot DROPS a >120KB file at the default cap but KEEPS it when the cap is raised', async () => {
  const tarball = makeTarball({ 'src/big.ts': bigContent, 'src/small.ts': 'const a = 1;' });
  const atDefault = await fetchRepoSnapshot(fakeOctokit(tarball), 'o', 'r', 'sha');
  assert.equal(atDefault.has('src/big.ts'), false, 'big file dropped at 120KB default');
  assert.equal(atDefault.has('src/small.ts'), true);

  const raised = await fetchRepoSnapshot(fakeOctokit(tarball), 'o', 'r', 'sha', { maxFileBytes: 250_000 });
  assert.equal(raised.has('src/big.ts'), true, 'big file kept when cap raised to 250KB');
  assert.ok((raised.get('src/big.ts') ?? '').length > 120_000, 'full content retained');
});

test('buildRepoContext gives a changed >120KB file its FULL content (via the raised snapshot cap)', async () => {
  const tarball = makeTarball({ 'src/big.ts': bigContent });
  const ctx = await buildRepoContext(fakeOctokit(tarball), 'o', 'r', 'sha', ['src/big.ts'], {
    maxFileBytes: 250_000,
    maxSourceFiles: 5,
  });
  const changed = ctx.changedContents.find((f) => f.path === 'src/big.ts');
  assert.ok(changed, 'changed large file must be present in context, not dropped');
  assert.ok(changed!.content.length > 120_000, 'changed large file has full content, not null/truncated');
});

test('readFile FALLS BACK to the GitHub API when a changed file is absent from the snapshot', async () => {
  // Snapshot excludes big.ts (simulate a tarball omission); the API returns it.
  const tarball = makeTarball({ 'src/other.ts': 'const a = 1;' });
  const ctx = await buildRepoContext(fakeOctokit(tarball, bigContent), 'o', 'r', 'sha', ['src/big.ts'], {
    maxFileBytes: 250_000,
    maxSourceFiles: 5,
  });
  const changed = ctx.changedContents.find((f) => f.path === 'src/big.ts');
  assert.ok(changed, 'a changed file missing from the snapshot is fetched via API fallback');
  assert.ok(changed!.content.length > 120_000);
});

test('a SMALL caller budget (nightly 24KB / autofix 32KB) must NOT shrink the snapshot', async () => {
  // M2 regression: passing the review's per-file limit straight through to the
  // snapshot made it drop every file over the caller's small budget — gutting
  // repo context for exactly the large files that carry the most context.
  const mid = 'const mid = () => {\n' + 'y'.repeat(60_000) + '\n};\n'; // ~60KB: over 24KB, under 120KB
  const tarball = makeTarball({ 'src/mid.ts': mid, 'src/small.ts': 'const a = 1;' });
  const ctx = await buildRepoContext(fakeOctokit(tarball), 'o', 'r', 'sha', ['src/small.ts'], {
    maxFileBytes: 24_000, // the nightly budget
    maxSourceFiles: 5,
  });
  assert.ok(
    ctx.treePaths.includes('src/mid.ts'),
    'a 60KB file must survive in the snapshot even when the caller budget is 24KB',
  );
});

test('the streaming snapshot parser enforces the total retained-byte cap', async () => {
  const tarball = makeTarball({
    'src/a.ts': 'a'.repeat(20_000),
    'src/b.ts': 'b'.repeat(20_000),
  });
  const snapshot = await fetchRepoSnapshot(fakeOctokit(tarball), 'o', 'r', 'sha', {
    maxFileBytes: 30_000,
    maxTotalBytes: 25_000,
  });
  assert.equal(snapshot.has('src/a.ts'), true);
  assert.equal(snapshot.has('src/b.ts'), false);
});

test('the snapshot keeps package metadata required by runtime verification', async () => {
  const snapshot = await fetchRepoSnapshot(
    fakeOctokit(makeTarball({
      'package.json': '{"scripts":{"test":"node --test"}}',
      'pnpm-lock.yaml': 'lockfileVersion: 9.0',
      'src/index.ts': 'export const answer = 42;',
    })),
    'o',
    'r',
    'sha',
  );
  assert.equal(snapshot.get('package.json'), '{"scripts":{"test":"node --test"}}');
  assert.equal(snapshot.has('pnpm-lock.yaml'), true);
});

test('the snapshot parser rejects an archive above its compressed-byte cap', async () => {
  const tarball = makeTarball({ 'src/a.ts': 'a'.repeat(10_000) });
  await assert.rejects(
    fetchRepoSnapshot(fakeOctokit(tarball), 'o', 'r', 'sha', { maxArchiveBytes: tarball.length - 1 }),
    /archive exceeds/,
  );
});
