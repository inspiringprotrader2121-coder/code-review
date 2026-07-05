import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppDatabase } from './database.js';

function db(): AppDatabase {
  return new AppDatabase(':memory:');
}

test('secondsSinceLastCompletedReview is null when this commit has never completed a review', () => {
  const d = db();
  assert.equal(d.secondsSinceLastCompletedReview(1, 'acme', 'api', 5, 'sha1'), null);
});

test('detects a just-completed review of the exact same commit (the cooldown trigger)', () => {
  const d = db();
  d.recordReviewRun({
    tenantId: 't1', installationId: 1, owner: 'acme', repo: 'api', pr: 5, headSha: 'sha1',
    action: 'command', status: 'completed', durationMs: 1000,
  });
  const s = d.secondsSinceLastCompletedReview(1, 'acme', 'api', 5, 'sha1');
  assert.ok(s !== null && s < 5, 'a review that just completed is ~0s ago, not null');
});

test('a DIFFERENT sha (a genuine new push) is unaffected — always null for that sha', () => {
  const d = db();
  d.recordReviewRun({
    tenantId: 't1', installationId: 1, owner: 'acme', repo: 'api', pr: 5, headSha: 'sha1',
    action: 'command', status: 'completed', durationMs: 1000,
  });
  assert.equal(
    d.secondsSinceLastCompletedReview(1, 'acme', 'api', 5, 'sha2'),
    null,
    'a new commit must never be throttled by an old commit\'s review',
  );
});

test('a failed or skipped run does NOT count as "recently reviewed" — cooldown only follows real completions', () => {
  const d = db();
  d.recordReviewRun({
    tenantId: 't1', installationId: 1, owner: 'acme', repo: 'api', pr: 5, headSha: 'sha1',
    action: 'command', status: 'failed', durationMs: 1000,
  });
  d.recordReviewRun({
    tenantId: 't1', installationId: 1, owner: 'acme', repo: 'api', pr: 5, headSha: 'sha1',
    action: 'command', status: 'skipped', durationMs: 0,
  });
  assert.equal(d.secondsSinceLastCompletedReview(1, 'acme', 'api', 5, 'sha1'), null);
});

test('a fix run on the same commit does not count as a "review" for cooldown purposes', () => {
  const d = db();
  d.recordReviewRun({
    tenantId: 't1', installationId: 1, owner: 'acme', repo: 'api', pr: 5, headSha: 'sha1',
    action: 'fix:ready', status: 'completed', durationMs: 1000,
  });
  assert.equal(d.secondsSinceLastCompletedReview(1, 'acme', 'api', 5, 'sha1'), null);
});

test('scoped per installation+repo+pr — does not leak across different PRs/repos', () => {
  const d = db();
  d.recordReviewRun({
    tenantId: 't1', installationId: 1, owner: 'acme', repo: 'api', pr: 5, headSha: 'sha1',
    action: 'command', status: 'completed', durationMs: 1000,
  });
  assert.equal(d.secondsSinceLastCompletedReview(1, 'acme', 'api', 6, 'sha1'), null, 'different PR');
  assert.equal(d.secondsSinceLastCompletedReview(1, 'acme', 'web', 5, 'sha1'), null, 'different repo');
  assert.equal(d.secondsSinceLastCompletedReview(2, 'acme', 'api', 5, 'sha1'), null, 'different installation');
});
