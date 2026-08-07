import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeFindings, toStoredFinding, reconcileFixedOnHead, type FileReader } from './merge.js';
import type { ReviewFinding } from './finding.js';

function finding(file: string, message: string, severity: ReviewFinding['severity'] = 'P1'): ReviewFinding {
  return {
    file,
    line: 10,
    severity,
    category: 'security',
    message,
    confidence: 0.9,
    ruleId: 'llm.security',
  };
}

/** A FileReader that serves fixed content per (path) regardless of ref. */
const readerFor = (files: Record<string, string | null>): FileReader => ({
  readFile: async (path) => (path in files ? files[path] : null),
});

test('a prior finding re-detected this run stays open', () => {
  const fa = finding('authz.ts', 'auth bypass');
  const prior = [toStoredFinding(fa, 'sha1')];
  const res = mergeFindings([fa], prior, 'sha2', {});
  assert.equal(res.newlyFixed.length, 0);
  assert.equal(res.stillOpen.length, 1);
});

test('P1 model-miss on a reviewed file is carried forward, not false-fixed', () => {
  const fa = finding('authz.ts', 'auth bypass', 'P1');
  const prior = [toStoredFinding(fa, 'sha1')];
  const res = mergeFindings([], prior, 'sha2', {
    reviewedFiles: new Set(['authz.ts']),
  });
  assert.equal(res.newlyFixed.length, 0, 'P1 must not auto-close from a model miss');
  assert.equal(res.stillOpen.length, 1);
});

test('P3 whose file WAS reviewed but is no longer detected is marked fixed', () => {
  const fa = finding('authz.ts', 'style nit', 'P3');
  const prior = [toStoredFinding(fa, 'sha1')];
  const res = mergeFindings([], prior, 'sha2', {
    reviewedFiles: new Set(['authz.ts']),
  });
  assert.equal(res.newlyFixed.length, 1);
  assert.equal(res.stillOpen.length, 0);
});

test('THE BUG FIX: a prior finding in an UN-reviewed file is carried forward, NOT marked fixed', () => {
  // Incremental push touched only handler.ts; authz.ts (which holds a P1) was
  // never reviewed this run, so its absence from `incoming` proves nothing —
  // carry it forward unchanged rather than falsely reporting it fixed.
  const auth = finding('authz.ts', 'auth bypass'); // prior P1, file not reviewed now
  const prior = [toStoredFinding(auth, 'sha1')];
  const res = mergeFindings([], prior, 'sha2', {
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
    reviewedFiles: new Set(), // a lockfile-only push reviewed nothing
  });
  assert.equal(res.newlyFixed.length, 0);
  assert.equal(res.stillOpen.length, 2);
});

test('without reviewedFiles: P1 on a NEW sha not re-detected stays open', () => {
  const a = toStoredFinding(finding('a.ts', 'bug a', 'P1'), 'sha1');
  const res = mergeFindings([], [a], 'sha2', {});
  assert.equal(res.newlyFixed.length, 0);
  assert.equal(res.stillOpen.length, 1);
});

test('without reviewedFiles: P3 on a NEW sha not re-detected is fixed', () => {
  const a = toStoredFinding(finding('a.ts', 'bug a', 'P3'), 'sha1');
  const res = mergeFindings([], [a], 'sha2', {});
  assert.equal(res.newlyFixed.length, 1);
});

test('THE FLIP-FLOP FIX: re-reviewing the SAME sha never marks a finding fixed (code unchanged)', () => {
  // A finding found at sha1, then the SAME sha1 is reviewed again (e.g. a manual
  // re-run, or a different model) and doesn't re-surface it. The code hasn't
  // changed, so it must NOT be marked fixed — carry it forward.
  const a = toStoredFinding(finding('a.ts', 'bug a'), 'sha1'); // lastSeenSha = sha1
  const res = mergeFindings([], [a], 'sha1', {
    reviewedFiles: new Set(['a.ts']),
    priorReviewSha: 'sha1',
  });
  assert.equal(res.newlyFixed.length, 0, 'unchanged code cannot be "fixed"');
  assert.equal(res.stillOpen.length, 1, 'the finding is carried forward, not lost');
});

test('a genuine new push that misses a P1 still carries it (no model-miss close)', () => {
  const a = toStoredFinding(finding('a.ts', 'bug a', 'P1'), 'sha1');
  const res = mergeFindings([], [a], 'sha2', {
    reviewedFiles: new Set(['a.ts']),
    priorReviewSha: 'sha1',
  });
  assert.equal(res.newlyFixed.length, 0);
  assert.equal(res.stillOpen.length, 1);
});

test('a genuine new push that misses a P3 retires it as fixed', () => {
  const a = toStoredFinding(finding('a.ts', 'bug a', 'P3'), 'sha1');
  const res = mergeFindings([], [a], 'sha2', {
    reviewedFiles: new Set(['a.ts']),
    priorReviewSha: 'sha1',
  });
  assert.equal(res.newlyFixed.length, 1);
});

test('a transient read-error fingerprint is protected from being marked fixed', () => {
  const a = toStoredFinding(finding('a.ts', 'bug a'), 'sha1');
  const res = mergeFindings([], [a], 'sha2', {
    reviewedFiles: new Set(['a.ts']),
    priorReviewSha: 'sha1',
    protectedFingerprints: new Set([a.fingerprint]),
  });
  assert.equal(res.newlyFixed.length, 0);
  assert.equal(res.stillOpen.length, 1);
});

test('a low-confidence re-detection still counts as seen and prevents false fixed', () => {
  const lowConfidence = { ...finding('a.ts', 'bug a'), confidence: 0.3 };
  const a = toStoredFinding(finding('a.ts', 'bug a'), 'sha1');
  const res = mergeFindings([lowConfidence], [a], 'sha2', {
    reviewedFiles: new Set(['a.ts']),
    priorReviewSha: 'sha1',
  });
  assert.equal(res.newlyFixed.length, 0, 're-detected below threshold must still block false fixed');
  assert.equal(res.toPost.length, 0, 'an already-open finding is not posted again');
  assert.equal(res.reviewOnly.length, 0, 'an already-open finding is not duplicated in manual review');
});

test('re-detection upgrades severity/message when incoming ranks higher', () => {
  const priorOpen = toStoredFinding(finding('a.ts', 'auth bypass!', 'P3'), 'sha1');
  // Same fingerprint (punctuation stripped) but higher severity + cleaned message.
  const upgraded = finding('a.ts', 'auth bypass', 'P1');
  const res = mergeFindings([upgraded], [priorOpen], 'sha2', {
    reviewedFiles: new Set(['a.ts']),
    priorReviewSha: 'sha1',
  });
  assert.equal(res.newlyFixed.length, 0);
  assert.equal(res.stillOpen.length, 1);
  assert.equal(res.stillOpen[0].severity, 'P1');
  assert.equal(res.stillOpen[0].message, 'auth bypass');
  assert.equal(res.toPost.length, 0);
});

test('a new low-confidence finding stays on the normal review surface', () => {
  const lowConfidence = { ...finding('a.ts', 'uncertain bug'), confidence: 0.3 };
  const res = mergeFindings([lowConfidence], [], 'sha2', {});
  assert.equal(res.toPost.length, 1, 'confidence is telemetry, not an output gate');
  assert.equal(res.reviewOnly.length, 0);
  assert.equal(res.toPost[0].message, 'uncertain bug');
});

test('an explicitly demoted candidate is retained on the manual-review surface', () => {
  const candidate = finding('a.ts', 'single-run candidate');
  const res = mergeFindings([], [], 'sha2', {
    manualCandidates: [{ finding: candidate, reason: 'Seen in only one repeated review sample.' }],
  });
  assert.equal(res.toPost.length, 0);
  assert.equal(res.reviewOnly.length, 1);
  assert.equal(res.reviewOnly[0].finding.message, 'single-run candidate');
});

test('a manual duplicate cannot displace a normal finding with the same fingerprint', () => {
  const normal = { ...finding('a.ts', 'same bug'), confidence: 0.2 };
  const manual = { ...normal, confidence: 0.99 };
  const res = mergeFindings([normal], [], 'sha2', {
    manualCandidates: [{ finding: manual, reason: 'Seen in only one repeated review sample.' }],
  });
  assert.equal(res.toPost.length, 1);
  assert.equal(res.toPost[0].confidence, 0.2, 'the normal surface owns the fingerprint');
  assert.equal(res.reviewOnly.length, 0);
});

test('P2-9: incoming duplicates are deduped by fingerprint before posting', () => {
  const f = finding('a.ts', 'bug a');
  const dup = { ...f, line: 20 };
  const res = mergeFindings([f, dup], [], 'sha2', {});
  assert.equal(res.toPost.length, 1);
});

// ——— Deterministic fix detection: retire ONLY when the recorded fix is present ———

const anchored = (file: string, originalCode: string, fixedCode?: string, severity: ReviewFinding['severity'] = 'P3'): ReviewFinding => ({
  ...finding(file, 'null deref on user', severity),
  ruleId: 'llm.correctness',
  severity,
  originalCode,
  fixedCode,
});

test('FIX LANDED: P3 original gone AND recorded fixedCode present → marked fixed', async () => {
  const f = anchored('user.ts', 'const name = user.profile.name;', 'const name = user?.profile?.name ?? "";');
  const prior = [toStoredFinding(f, 'sha1')];
  const reader = readerFor({ 'user.ts': 'const name = user?.profile?.name ?? "";' });
  const res = await reconcileFixedOnHead(prior, 'sha2', reader);
  assert.equal(res.newlyFixed.length, 1, 'the exact recorded fix is present → fixed');
  assert.equal(res.stillOpen.length, 0);
});

test('FIX LANDED: P1 with original gone AND fixedCode present → marked fixed', async () => {
  const f = anchored(
    'auth.ts',
    'const role = req.query.role',
    'const role = session.user.role',
    'P1',
  );
  const prior = [toStoredFinding(f, 'sha1')];
  const reader = readerFor({ 'auth.ts': 'const role = session.user.role' });
  const res = await reconcileFixedOnHead(prior, 'sha2', reader);
  assert.equal(res.newlyFixed.length, 1, 'deterministic fixLanded may close P1');
  assert.equal(res.stillOpen.length, 0);
});

test('INCIDENTAL fixedCode: a P1 is NOT closed when original still present', async () => {
  // fixedCode is coincidentally present; original remains → not fixLanded.
  const f = anchored('auth.ts', 'const role = req.query.role', 'const role = session.user.role', 'P1');
  const prior = [toStoredFinding(f, 'sha1')];
  const reader = readerFor({
    'auth.ts': 'const role = session.user.role; // (present for unrelated reasons)\nconst role = req.query.role',
  });
  const res = await reconcileFixedOnHead(prior, 'sha2', reader);
  assert.equal(res.newlyFixed.length, 0, 'original still present → not fixed');
  assert.equal(res.stillOpen.length, 1);
});

test('REGRESSION GUARD: flagged line RENAMED but bug remains (no fixedCode present) → NOT fixed', async () => {
  // This is the P1 the old originalCode-absence-alone check caused: the injectable
  // line is renamed but still injectable; must stay open, not silently retire.
  const f = anchored('db.ts', 'db.query("... WHERE id = " + userId)', 'db.query("... WHERE id = ?", [userId])');
  const prior = [toStoredFinding(f, 'sha1')];
  // renamed userId → req.params.id, still concatenated (still injectable). fixedCode NOT present.
  const reader = readerFor({ 'db.ts': 'db.query("... WHERE id = " + req.params.id)' });
  const res = await reconcileFixedOnHead(prior, 'sha2', reader);
  assert.equal(res.newlyFixed.length, 0, 'an incidental rename must NOT mark a still-open bug fixed');
  assert.equal(res.stillOpen.length, 1, 'it is carried forward for the model to re-check');
});

test('NO RECORDED FIX: original gone but finding has no fixedCode → NOT anchor-retired (mergeFindings decides)', async () => {
  const f = anchored('user.ts', 'const name = user.profile.name;'); // no fixedCode
  const prior = [toStoredFinding(f, 'sha1')];
  const reader = readerFor({ 'user.ts': 'const name = user?.profile?.name ?? "";' });
  const res = await reconcileFixedOnHead(prior, 'sha2', reader);
  assert.equal(res.newlyFixed.length, 0, 'no fix to corroborate → do not auto-close');
  assert.equal(res.stillOpen.length, 1);
});

test('STILL OPEN: flagged snippet still present → stays open even if fixedCode also happens to appear', async () => {
  const f = anchored('user.ts', 'const name = user.profile.name;', 'const name = user?.profile?.name;');
  const prior = [toStoredFinding(f, 'sha1')];
  const reader = readerFor({ 'user.ts': 'const name = user.profile.name; const other = user?.profile?.name;' });
  const res = await reconcileFixedOnHead(prior, 'sha2', reader);
  assert.equal(res.newlyFixed.length, 0, 'original still present → not fixed');
  assert.equal(res.stillOpen.length, 1);
});

test('FILE DELETED still marks fixed; TRANSIENT read error still protects', async () => {
  const f = anchored('gone.ts', 'const secret = process.env.KEY;', 'const secret = vault.get("KEY");');
  const del = await reconcileFixedOnHead([toStoredFinding(f, 'sha1')], 'sha2', readerFor({}));
  assert.equal(del.newlyFixed.length, 1, 'deleted file → fixed');

  const throwing: FileReader = { readFile: async () => { throw new Error('rate limited'); } };
  const trans = await reconcileFixedOnHead([toStoredFinding(f, 'sha1')], 'sha2', throwing);
  assert.equal(trans.newlyFixed.length, 0, 'transient error never marks fixed');
  assert.equal(trans.readErrorFps.length, 1);
});
