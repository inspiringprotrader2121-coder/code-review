import assert from 'node:assert/strict';
import test from 'node:test';
import type { Octokit } from '@octokit/rest';
import { fetchCompareDiff } from './diff.js';

test('fetchCompareDiff aggregates files from every compare page', async () => {
  const pages = [
    Array.from({ length: 100 }, (_, i) => changedFile(`first-${i}.ts`)),
    Array.from({ length: 25 }, (_, i) => changedFile(`second-${i}.ts`)),
  ];
  const octokit = {
    paginate: {
      iterator: async function* () {
        for (const files of pages) yield { data: { files } };
      },
    },
    rest: { repos: { compareCommits: () => undefined } },
  } as unknown as Octokit;

  const result = await fetchCompareDiff(octokit, 'acme', 'widgets', 'base', 'head', {
    maxFileBytes: 100_000,
    maxFiles: 200,
  });

  assert.equal(result.files.length, 125);
  assert.equal(result.coverage.reviewed, 125);
  assert.equal(result.coverage.complete, true);
  assert.equal(result.files.at(-1)?.filename, 'second-24.ts');
});

function changedFile(filename: string) {
  return { filename, status: 'modified', patch: '@@ -1 +1 @@\n-old\n+new' };
}
