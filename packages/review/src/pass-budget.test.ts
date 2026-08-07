import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildReviewPassAngles,
  isLargePr,
  selectRiskProbes,
} from './pass-budget.js';

test('isLargePr respects file and patch-char caps', (t) => {
  t.after(() => {
    delete process.env.ORVEX_LARGE_PR_FILES;
    delete process.env.ORVEX_LARGE_PR_PATCH_CHARS;
  });
  process.env.ORVEX_LARGE_PR_FILES = '3';
  assert.equal(isLargePr([{ filename: 'a.ts' }, { filename: 'b.ts' }]), false);
  assert.equal(isLargePr([{ filename: 'a.ts' }, { filename: 'b.ts' }, { filename: 'c.ts' }]), true);
  delete process.env.ORVEX_LARGE_PR_FILES;
  process.env.ORVEX_LARGE_PR_PATCH_CHARS = '10';
  assert.equal(isLargePr([{ filename: 'a.ts', patch: '123456789' }]), false);
  assert.equal(isLargePr([{ filename: 'a.ts', patch: '12345678901' }]), true);
});

test('buildReviewPassAngles keeps breadth last when present', () => {
  process.env.ORVEX_BREADTH_ON = 'always';
  process.env.ORVEX_REMOVED_BEHAVIOR = 'always';
  try {
    const tags = buildReviewPassAngles({
      modelTier: 'multi-model',
      files: [{ filename: 'a.ts', patch: '+x', status: 'modified' }],
    }).map((a) => a.tag);
    assert.deepEqual(tags, [
      'general',
      'deep-dive',
      'removed-behavior/callers',
      'perf/completeness/api',
    ]);
  } finally {
    delete process.env.ORVEX_BREADTH_ON;
    delete process.env.ORVEX_REMOVED_BEHAVIOR;
  }
});

test('buildReviewPassAngles gives a small multi-model PR only general + deep-dive', (t) => {
  t.after(() => {
    delete process.env.ORVEX_LARGE_PR_FILES;
    delete process.env.ORVEX_LARGE_PR_PATCH_CHARS;
  });
  delete process.env.ORVEX_BREADTH_ON;
  delete process.env.ORVEX_REMOVED_BEHAVIOR;
  // A small diff: no deletes/renames, under the large-PR file/char caps.
  const small = Array.from({ length: 5 }, (_, i) => ({
    filename: `src/f${i}.ts`,
    patch: '+const x = 1;\n',
    status: 'modified',
  }));
  const tags = buildReviewPassAngles({ modelTier: 'multi-model', files: small }).map((a) => a.tag);
  assert.deepEqual(tags, ['general', 'deep-dive']);
});

test('buildReviewPassAngles adds breadth for a genuinely large PR', (t) => {
  t.after(() => delete process.env.ORVEX_LARGE_PR_FILES);
  delete process.env.ORVEX_BREADTH_ON;
  process.env.ORVEX_LARGE_PR_FILES = '40';
  const large = Array.from({ length: 41 }, (_, i) => ({
    filename: `src/f${i}.ts`,
    patch: '+const x = 1;\n',
    status: 'modified',
  }));
  const tags = buildReviewPassAngles({ modelTier: 'multi-model', files: large }).map((a) => a.tag);
  assert.ok(tags.includes('perf/completeness/api'), 'large PR adds the breadth lens');
  assert.equal(tags[0], 'general');
  assert.equal(tags[1], 'deep-dive');
});

test('selectRiskProbes returns empty for zero budget', () => {
  assert.deepEqual(selectRiskProbes([{ files: ['a.ts'] }], 0), []);
});
