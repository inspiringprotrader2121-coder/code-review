import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppDatabase } from './database.js';

function db(): { d: AppDatabase; tenantId: string } {
  const d = new AppDatabase(':memory:');
  return { d, tenantId: d.createTenant(`command-cap-${Math.random()}`).id };
}

function cmd(d: AppDatabase, tenantId: string, owner: string, kind: string, n: number): void {
  for (let i = 0; i < n; i++) {
    d.recordReviewRun({
      tenantId,
      installationId: 1,
      owner,
      repo: 'api',
      pr: 1,
      headSha: `s${i}`,
      action: `cmd:${kind}`,
      status: 'completed',
      durationMs: 0,
    });
  }
}

test('countAccountCommandRuns counts cmd:* runs, case-insensitively by owner', () => {
  const { d, tenantId } = db();
  cmd(d, tenantId, 'Acme', 'ask', 3);
  cmd(d, tenantId, 'Acme', 'explain', 2);
  assert.equal(d.countAccountCommandRuns('acme'), 5, 'ask + explain both count, case-insensitive');
  assert.equal(d.countAccountCommandRuns('other'), 0);
});

test('interactive commands are EXCLUDED from the review caps (do not consume trial/monthly)', () => {
  const { d, tenantId } = db();
  cmd(d, tenantId, 'acme', 'ask', 50);
  // 50 ask commands must not register as reviews
  assert.equal(d.countAccountReviews('acme'), 0, 'cmd:* rows are not reviews');
});

test('real reviews still count as reviews; commands still count as commands (no cross-contamination)', () => {
  const { d, tenantId } = db();
  d.recordReviewRun({
    tenantId,
    installationId: 1,
    owner: 'acme',
    repo: 'api',
    pr: 1,
    headSha: 'r1',
    action: 'synchronize',
    status: 'completed',
    durationMs: 1000,
  });
  cmd(d, tenantId, 'acme', 'ask', 4);
  assert.equal(d.countAccountReviews('acme'), 1);
  assert.equal(d.countAccountCommandRuns('acme'), 4);
});
