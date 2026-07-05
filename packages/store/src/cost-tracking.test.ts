import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppDatabase } from './database.js';

function db(): AppDatabase {
  return new AppDatabase(':memory:');
}

test('completeReviewRun persists token usage + cost, and sumAccountCost aggregates it', () => {
  const d = db();
  const id = d.startReviewRun({
    tenantId: 't1', installationId: 1, owner: 'acme', repo: 'api', pr: 1, headSha: 'sha1', action: 'manual',
  });
  d.completeReviewRun(id, {
    status: 'completed', durationMs: 1000, findingsNew: 2,
    inputTokens: 500_000, outputTokens: 100_000, costUsd: 0.27,
  });
  const spend = d.sumAccountCost('acme');
  assert.equal(spend.reviews, 1);
  assert.ok(Math.abs(spend.costUsd - 0.27) < 1e-9);
});

test('sumAccountCost is owner-scoped (case-insensitive) and windowed', () => {
  const d = db();
  for (const owner of ['acme', 'ACME', 'other']) {
    const id = d.startReviewRun({
      tenantId: 't1', installationId: 1, owner, repo: 'api', pr: 1, headSha: 's', action: 'manual',
    });
    d.completeReviewRun(id, { status: 'completed', durationMs: 1, costUsd: 0.10 });
  }
  const acme = d.sumAccountCost('acme');
  assert.equal(acme.reviews, 2, 'acme + ACME both count');
  assert.ok(Math.abs(acme.costUsd - 0.20) < 1e-9);
  assert.equal(d.sumAccountCost('other').reviews, 1);
});

test('getWorkspaceStats includes total spend for the window', () => {
  const d = db();
  const id = d.startReviewRun({
    tenantId: 't1', installationId: 1, owner: 'acme', repo: 'api', pr: 1, headSha: 's', action: 'manual',
  });
  d.completeReviewRun(id, { status: 'completed', durationMs: 1, costUsd: 0.5 });
  const stats = d.getWorkspaceStats('t1');
  assert.ok(Math.abs(stats.costUsd - 0.5) < 1e-9);
});
