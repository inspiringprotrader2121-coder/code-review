import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CASES,
  EXPECTED_GOLD_LABEL_COUNTS,
  evaluationCorpusFingerprint,
  evaluationCorpusLabelCounts,
} from './cases.js';

test('every evaluation label is pinned to one immutable commit', () => {
  const names = new Set<string>();

  for (const c of CASES) {
    assert.match(c.sha, /^[0-9a-f]{40}$/i, `${c.name} must use a full commit SHA`);
    assert.match(c.baseSha, /^[0-9a-f]{40}$/i, `${c.name} must use a full base SHA`);
    assert.notEqual(c.baseSha, c.sha, `${c.name} must compare two distinct immutable commits`);
    assert.equal(names.has(c.name), false, `${c.name} must be unique`);
    names.add(c.name);
    assert.ok(
      (c.shouldFlag?.length ?? 0) +
        (c.shouldFlagSevere?.length ?? 0) +
        (c.shouldNotFlag?.length ?? 0) >
        0,
      `${c.name} must have a real positive or negative label`,
    );
    assert.ok(c.note?.trim(), `${c.name} must retain its hand-verification note`);
    assert.match(
      c.evidence.path,
      /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$)).+/,
      `${c.name} must have a repository-relative evidence path`,
    );
    assert.ok(
      Number.isSafeInteger(c.evidence.line) && c.evidence.line >= 1,
      `${c.name} must pin an evidence line`,
    );
    assert.equal(
      c.evidence.sha,
      c.sha,
      `${c.name} must pin the evidence to its immutable reviewed SHA`,
    );
    assert.equal(c.evidence.provenance, 'hand-verified-immutable-source');
    const positiveLabels = (c.shouldFlag?.length ?? 0) + (c.shouldFlagSevere?.length ?? 0);
    if (positiveLabels > 0) {
      assert.notEqual(
        c.evidence.reviewOutcome,
        'false-positive',
        `${c.name} must not turn a negative witness into a positive label`,
      );
    } else {
      assert.equal(
        c.evidence.reviewOutcome,
        'false-positive',
        `${c.name} must document why its negative label is negative`,
      );
    }
  }
});

test('the evaluation corpus has a stable, labelled snapshot identity', () => {
  const fingerprint = evaluationCorpusFingerprint();
  assert.match(fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(
    fingerprint,
    evaluationCorpusFingerprint(),
    'the same labels must produce the same digest',
  );

  const labels = evaluationCorpusLabelCounts();
  assert.deepEqual(labels, EXPECTED_GOLD_LABEL_COUNTS);
});

test('the audit-export regression labels retain their immutable source witnesses', () => {
  const expected = new Map([
    [
      'audit-export-client-backpressure-truncates-snapshot',
      ['639a97595d5a8d1d51c9f83e327ba507090f4bc2', 'P1'],
    ],
    [
      'audit-export-hard-timeout-breaks-uncapped-export',
      ['350302622d3a068b6d8a5c7c371c8e145338f1a4', 'P2'],
    ],
    [
      'audit-export-pipeline-error-keeps-download-headers',
      ['350302622d3a068b6d8a5c7c371c8e145338f1a4', 'P2'],
    ],
  ]);
  for (const [name, [sha, severity]] of expected) {
    const entry = CASES.find((candidate) => candidate.name === name);
    assert.ok(entry, `${name} must remain in the labelled corpus`);
    assert.equal(entry.sha, sha);
    assert.equal(entry.evidence.path, 'backend/src/services/auth.js');
    assert.ok(entry.shouldFlagSevere?.some((label) => label.minSeverity === severity));
  }
});
