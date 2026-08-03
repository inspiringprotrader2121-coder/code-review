import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CASES, evaluationCorpusFingerprint, evaluationCorpusLabelCounts } from './cases.js';

test('every evaluation label is pinned to one immutable commit', () => {
  const names = new Set<string>();

  for (const c of CASES) {
    assert.match(c.sha, /^[0-9a-f]{40}$/i, `${c.name} must use a full commit SHA`);
    assert.equal(names.has(c.name), false, `${c.name} must be unique`);
    names.add(c.name);
    assert.ok(
      (c.shouldFlag?.length ?? 0) + (c.shouldFlagSevere?.length ?? 0) + (c.shouldNotFlag?.length ?? 0) > 0,
      `${c.name} must have a real positive or negative label`,
    );
    assert.ok(c.note?.trim(), `${c.name} must retain its hand-verification note`);
  }
});

test('the evaluation corpus has a stable, labelled snapshot identity', () => {
  const fingerprint = evaluationCorpusFingerprint();
  assert.match(fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(fingerprint, evaluationCorpusFingerprint(), 'the same labels must produce the same digest');

  const labels = evaluationCorpusLabelCounts();
  assert.ok(labels.positive > 0, 'the corpus needs at least one real-bug label');
  assert.ok(labels.negative > 0, 'the corpus needs at least one false-positive label');
});
