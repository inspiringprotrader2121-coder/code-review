import assert from 'node:assert/strict';
import test from 'node:test';
import { assertCompleteReviewInput } from './review-preparation.js';

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
