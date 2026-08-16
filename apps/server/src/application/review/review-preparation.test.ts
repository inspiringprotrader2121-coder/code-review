import assert from 'node:assert/strict';
import test from 'node:test';
import { assertCompleteReviewInput, selectFilesForModelReview } from './review-preparation.js';

test('complete GitHub input can proceed to model scheduling', () => {
  assert.doesNotThrow(() =>
    assertCompleteReviewInput({
      candidates: 2,
      reviewed: 2,
      skippedByCap: 0,
      truncatedFiles: 0,
      deletedFiles: 0,
      omittedPatch: 0,
      complete: true,
    }),
  );
});

test('incomplete GitHub input stops before a partial model review is scheduled', () => {
  assert.throws(
    () =>
      assertCompleteReviewInput({
        candidates: 3_000,
        reviewed: 3_000,
        skippedByCap: 0,
        truncatedFiles: 1,
        deletedFiles: 0,
        omittedPatch: 1,
        complete: false,
        githubCapHit: true,
      }),
    /review input coverage incomplete; no model calls were made .*GitHub's file limit.*truncated patch.*missing patch/,
  );
});

test('deleted files with patches are reviewable so required models still run', () => {
  const files = selectFilesForModelReview([
    { filename: 'gone.ts', patch: '@@ -1 +0,0 @@\n-old\n', status: 'removed' },
    { filename: 'app.png', patch: '', status: 'added' },
    { filename: 'keep.ts', patch: '@@ -1 +1 @@\n-a\n+b\n', status: 'modified' },
  ]);
  assert.deepEqual(
    files.map((file) => file.filename),
    ['gone.ts', 'keep.ts'],
  );
});

test('binary-only changes are not treated as a completed model review', () => {
  assert.deepEqual(
    selectFilesForModelReview([{ filename: 'app.png', patch: '', status: 'added' }]),
    [],
  );
});
