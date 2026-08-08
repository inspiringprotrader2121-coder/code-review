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

test('buildReviewPassAngles gives small multi-model PRs the full four-pass track', () => {
  delete process.env.ORVEX_BREADTH_ON;
  delete process.env.ORVEX_REMOVED_BEHAVIOR;
  // Small diff, no deletes — Verify/Enterprise must still run all four discovery passes.
  const small = Array.from({ length: 5 }, (_, i) => ({
    filename: `src/f${i}.ts`,
    patch: '+const x = 1;\n',
    status: 'modified',
  }));
  const tags = buildReviewPassAngles({ modelTier: 'multi-model', files: small }).map((a) => a.tag);
  assert.deepEqual(tags, [
    'general',
    'deep-dive',
    'removed-behavior/callers',
    'perf/completeness/api',
  ]);
});

test('buildReviewPassAngles dual-model stays at general + deep-dive on small PRs', () => {
  delete process.env.ORVEX_BREADTH_ON;
  delete process.env.ORVEX_REMOVED_BEHAVIOR;
  const small = Array.from({ length: 5 }, (_, i) => ({
    filename: `src/f${i}.ts`,
    patch: '+const x = 1;\n',
    status: 'modified',
  }));
  const tags = buildReviewPassAngles({ modelTier: 'dual-model', files: small }).map((a) => a.tag);
  assert.deepEqual(tags, ['general', 'deep-dive']);
});

test('buildReviewPassAngles can still opt multi-model back to conditional lenses', () => {
  process.env.ORVEX_BREADTH_ON = 'deep-or-large';
  process.env.ORVEX_REMOVED_BEHAVIOR = 'deletes-or-renames';
  try {
    const small = Array.from({ length: 5 }, (_, i) => ({
      filename: `src/f${i}.ts`,
      patch: '+const x = 1;\n',
      status: 'modified',
    }));
    const tags = buildReviewPassAngles({ modelTier: 'multi-model', files: small }).map((a) => a.tag);
    assert.deepEqual(tags, ['general', 'deep-dive']);
  } finally {
    delete process.env.ORVEX_BREADTH_ON;
    delete process.env.ORVEX_REMOVED_BEHAVIOR;
  }
});

test('selectRiskProbes returns empty for zero budget', () => {
  assert.deepEqual(selectRiskProbes([{ files: ['a.ts'] }], 0), []);
});
