import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterChangedFiles } from './diff-filter.js';

const file = (filename: string, over: Partial<{ status: string; patch: string; truncated: boolean }> = {}) => ({
  filename,
  status: (over.status ?? 'modified') as never,
  patch: over.patch ?? 'diff',
  previousFilename: undefined,
  truncated: over.truncated ?? false,
});

test('coverage is COMPLETE when nothing is dropped or truncated', () => {
  const { files, coverage } = filterChangedFiles([file('a.ts'), file('b.ts')], { maxFileBytes: 100_000, maxFiles: 50 });
  assert.equal(files.length, 2);
  assert.equal(coverage.candidates, 2);
  assert.equal(coverage.reviewed, 2);
  assert.equal(coverage.skippedByCap, 0);
  assert.equal(coverage.truncatedFiles, 0);
  assert.equal(coverage.complete, true);
});

test('maxFiles cap COUNTS the dropped files (not a silent break) and marks incomplete', () => {
  const many = Array.from({ length: 10 }, (_, i) => file(`f${i}.ts`));
  const { files, coverage } = filterChangedFiles(many, { maxFileBytes: 100_000, maxFiles: 3 });
  assert.equal(files.length, 3, 'only maxFiles reviewed');
  assert.equal(coverage.candidates, 10, 'all 10 counted as candidates');
  assert.equal(coverage.skippedByCap, 7, 'the 7 over the cap are counted, not silently lost');
  assert.equal(coverage.complete, false);
});

test('a truncated patch marks coverage incomplete', () => {
  const { coverage } = filterChangedFiles([file('big.ts', { patch: 'x'.repeat(500) })], { maxFileBytes: 100, maxFiles: 50 });
  assert.equal(coverage.truncatedFiles, 1);
  assert.equal(coverage.complete, false);
});

test('intentionally-skipped lockfiles are NOT counted as coverage gaps', () => {
  const { files, coverage } = filterChangedFiles(
    [file('src/a.ts'), file('pnpm-lock.yaml'), file('dist/bundle.js')],
    { maxFileBytes: 100_000, maxFiles: 50 },
  );
  assert.equal(files.length, 1, 'only the real source file is reviewed');
  assert.equal(coverage.candidates, 1, 'lockfile/dist are not candidates');
  assert.equal(coverage.complete, true, 'skipping a lockfile is not an incomplete review');
});

test('deletions are counted (informational) but do not by themselves make coverage incomplete', () => {
  const { coverage } = filterChangedFiles([file('gone.ts', { status: 'removed', patch: '' })], { maxFileBytes: 100_000, maxFiles: 50 });
  assert.equal(coverage.deletedFiles, 1);
  assert.equal(coverage.complete, true);
});

test('a file whose patch GitHub OMITTED is a coverage gap, not "reviewed"', () => {
  const { files, coverage } = filterChangedFiles(
    [
      file('normal.ts'),
      { filename: 'huge.ts', status: 'modified' as never, patch: undefined, previousFilename: undefined, truncated: false },
    ],
    { maxFileBytes: 100_000, maxFiles: 50 },
  );
  assert.equal(files.length, 2, 'the file is still listed (name/status are useful)');
  assert.equal(coverage.candidates, 2);
  assert.equal(coverage.omittedPatch, 1);
  assert.equal(coverage.reviewed, 1, 'the patchless file is NOT counted as reviewed');
  assert.equal(coverage.complete, false, 'omitted patch → coverage is incomplete');
});

test('a REMOVED file without a patch is expected — coverage stays complete', () => {
  const { coverage } = filterChangedFiles(
    [{ filename: 'gone.ts', status: 'removed' as never, patch: undefined, previousFilename: undefined, truncated: false }],
    { maxFileBytes: 100_000, maxFiles: 50 },
  );
  assert.equal(coverage.deletedFiles, 1);
  assert.equal(coverage.omittedPatch, 0);
  assert.equal(coverage.complete, true);
});
