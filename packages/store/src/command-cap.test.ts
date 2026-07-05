import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppDatabase } from './database.js';

function db(): AppDatabase {
  return new AppDatabase(':memory:');
}

function cmd(d: AppDatabase, owner: string, kind: string, n: number): void {
  for (let i = 0; i < n; i++) {
    d.recordReviewRun({
      tenantId: 't1', installationId: 1, owner, repo: 'api', pr: 1, headSha: `s${i}`,
      action: `cmd:${kind}`, status: 'completed', durationMs: 0,
    });
  }
}

test('countAccountCommandRuns counts cmd:* runs, case-insensitively by owner', () => {
  const d = db();
  cmd(d, 'Acme', 'ask', 3);
  cmd(d, 'Acme', 'explain', 2);
  assert.equal(d.countAccountCommandRuns('acme'), 5, 'ask + explain both count, case-insensitive');
  assert.equal(d.countAccountCommandRuns('other'), 0);
});

test('interactive commands are EXCLUDED from the review caps (do not consume trial/monthly)', () => {
  const d = db();
  cmd(d, 'acme', 'ask', 50);
  // 50 ask commands must not register as reviews
  assert.equal(d.countAccountReviews('acme'), 0, 'cmd:* rows are not reviews');
});

test('real reviews still count as reviews; commands still count as commands (no cross-contamination)', () => {
  const d = db();
  d.recordReviewRun({
    tenantId: 't1', installationId: 1, owner: 'acme', repo: 'api', pr: 1, headSha: 'r1',
    action: 'synchronize', status: 'completed', durationMs: 1000,
  });
  cmd(d, 'acme', 'ask', 4);
  assert.equal(d.countAccountReviews('acme'), 1);
  assert.equal(d.countAccountCommandRuns('acme'), 4);
});
