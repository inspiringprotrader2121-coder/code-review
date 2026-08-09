import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { buildRepoContext } from './repo-context.js';

function tarEntry(name: string, content: string): Buffer {
  const data = Buffer.from(content, 'utf8');
  const header = Buffer.alloc(512, 0);
  header.write(name.slice(0, 100), 0, 'utf8');
  header.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 'utf8');
  header.write('0', 156, 'utf8');
  const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512, 0);
  data.copy(padded);
  return Buffer.concat([header, padded]);
}

function fakeOctokit(files: Record<string, string>) {
  const tarball = gzipSync(
    Buffer.concat([
      ...Object.entries(files).map(([name, content]) => tarEntry(`repo-sha/${name}`, content)),
      Buffer.alloc(1024, 0),
    ]),
  );
  return {
    rest: {
      repos: {
        downloadTarballArchive: async () => ({
          data: tarball.buffer.slice(tarball.byteOffset, tarball.byteOffset + tarball.byteLength),
        }),
      },
    },
  } as never;
}

test('repository context relevance-ranks direct contracts and callers and discloses caps', async () => {
  const context = await buildRepoContext(
    fakeOctokit({
      'src/changed.ts': [
        "import { generic } from './generic';",
        "import { rareContract } from './rare';",
        'export const changedEntry = () => rareContract(generic);',
      ].join('\n'),
      'src/generic.ts': 'export const generic = 1;',
      'src/rare.ts': 'export const rareContract = (value: number) => value;',
      'src/caller-generic.ts': "import { changedEntry } from './changed';\nchangedEntry();",
      'src/caller-ranked.ts':
        "import { changedEntry } from './changed';\nconst rareContract = changedEntry();",
    }),
    'o',
    'r',
    'sha',
    ['src/changed.ts'],
    { maxRelated: 1, maxDependents: 1 },
  );

  assert.equal(context.related[0]?.path, 'src/rare.ts');
  assert.deepEqual(context.omittedRelated, ['src/generic.ts']);
  assert.equal(context.dependents[0]?.path, 'src/caller-ranked.ts');
  assert.deepEqual(context.omittedDependents, ['src/caller-generic.ts']);
});

test('repository context accounts for omitted changed sources and retains zero-score graph candidates', async () => {
  const context = await buildRepoContext(
    fakeOctokit({
      'src/changed.ts':
        "import sideEffect from './side-effect';\nexport const changeToken = sideEffect;",
      'src/second.ts': 'export const secondChange = 2;',
      'src/side-effect.ts': 'export default null;',
    }),
    'o',
    'r',
    'sha',
    ['src/changed.ts', 'src/second.ts'],
    { maxSourceFiles: 1, maxRelated: 1 },
  );

  assert.deepEqual(
    context.changedContents.map((file) => file.path),
    ['src/changed.ts'],
  );
  assert.deepEqual(context.omittedChangedContents, ['src/second.ts']);
  assert.deepEqual(
    context.related.map((file) => file.path),
    ['src/side-effect.ts'],
  );
  assert.deepEqual(context.omittedRelated, []);
});
