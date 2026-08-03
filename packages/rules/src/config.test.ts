import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReviewConfigYaml, DEFAULT_REVIEW_CONFIG } from './config.js';

test('valid YAML parses; defaults apply for omitted keys', () => {
  const cfg = parseReviewConfigYaml('max_comments: 10\nignore:\n  - "**/gen/**"\n');
  assert.equal(cfg.max_comments, 10);
  assert.deepEqual(cfg.ignore, ['**/gen/**']);
  assert.equal(cfg.fold_medium, DEFAULT_REVIEW_CONFIG.fold_medium);
});

test('malformed YAML falls back to defaults AND logs a warning (never silent)', () => {
  const warnings: string[] = [];
  const orig = console.warn;
  console.warn = (msg?: unknown) => warnings.push(String(msg));
  try {
    const cfg = parseReviewConfigYaml('max_comments: [unclosed');
    assert.deepEqual(cfg, DEFAULT_REVIEW_CONFIG);
    const bad = parseReviewConfigYaml('max_comments: "not-a-number"');
    assert.deepEqual(bad, DEFAULT_REVIEW_CONFIG);
  } finally {
    console.warn = orig;
  }
  assert.equal(warnings.length, 2, 'each malformed config produced a warning');
  assert.match(warnings[0], /not valid YAML/);
  assert.match(warnings[1], /failed validation/);
});

test('empty/missing config returns defaults without warning', () => {
  assert.deepEqual(parseReviewConfigYaml(null), DEFAULT_REVIEW_CONFIG);
  assert.deepEqual(parseReviewConfigYaml('  '), DEFAULT_REVIEW_CONFIG);
});
