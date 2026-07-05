import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeFindings, toStoredFinding } from './merge.js';
import type { ReviewFinding } from './finding.js';

function finding(file: string, message: string): ReviewFinding {
  return {
    file,
    line: 10,
    severity: 'P1',
    category: 'security',
    message,
    confidence: 0.9,
    ruleId: 'llm.security',
  };
}

test('a prior finding re-detected this run stays open', () => {
  const fa = finding('authz.ts', 'auth bypass');
  const prior = [toStoredFinding(fa, 'sha1')];
  const res = mergeFindings([fa], prior, 'sha2', { minConfidence: 0.6 });
  assert.equal(res.newlyFixed.length, 0);
  assert.equal(res.stillOpen.length, 1);
});

test('a prior finding whose file WAS reviewed but is no longer detected is marked fixed', () => {
  const fa = finding('authz.ts', 'auth bypass');
  const prior = [toStoredFinding(fa, 'sha1')];
  // reviewedFiles includes authz.ts, incoming is empty → genuinely fixed
  const res = mergeFindings([], prior, 'sha2', {
    minConfidence: 0.6,
    reviewedFiles: new Set(['authz.ts']),
  });
  assert.equal(res.newlyFixed.length, 1);
  assert.equal(res.stillOpen.length, 0);
});

test('THE BUG FIX: a prior finding in an UN-reviewed file is carried forward, NOT marked fixed', () => {
  // Incremental push touched only handler.ts; authz.ts (which holds a P1) was
  // never reviewed this run, so its absence from `incoming` must not retire it.
  const auth = finding('authz.ts', 'auth bypass'); // prior P1, file not reviewed now
  const prior = [toStoredFinding(auth, 'sha1')];
  const res = mergeFindings([], prior, 'sha2', {
    minConfidence: 0.6,
    reviewedFiles: new Set(['handler.ts']), // authz.ts NOT in the reviewed set
  });
  assert.equal(res.newlyFixed.length, 0, 'the un-reviewed P1 must NOT be marked fixed');
  assert.equal(res.stillOpen.length, 1, 'it is carried forward as still-open');
  assert.equal(res.stillOpen[0].file, 'authz.ts');
});

test('empty-diff push (reviewedFiles empty) carries ALL prior findings forward, marks none fixed', () => {
  const a = toStoredFinding(finding('a.ts', 'bug a'), 'sha1');
  const b = toStoredFinding(finding('b.ts', 'bug b'), 'sha1');
  const res = mergeFindings([], [a, b], 'sha2', {
    minConfidence: 0.6,
    reviewedFiles: new Set(), // a lockfile-only push reviewed nothing
  });
  assert.equal(res.newlyFixed.length, 0);
  assert.equal(res.stillOpen.length, 2);
});

test('without reviewedFiles (legacy/full-review callers) behavior is unchanged: absence = fixed', () => {
  const a = toStoredFinding(finding('a.ts', 'bug a'), 'sha1');
  const res = mergeFindings([], [a], 'sha2', { minConfidence: 0.6 });
  assert.equal(res.newlyFixed.length, 1);
});
