import assert from 'node:assert/strict';
import test from 'node:test';
import { FinalizationService } from './finalization-service.js';

function admittedReview() {
  const completed: unknown[] = [];
  const refunds: string[] = [];
  const store = {
    completeReviewRun: (_runId: string, patch: unknown) => completed.push(patch),
    refundOverageCredits: (_runId: string, note?: string) => {
      refunds.push(note ?? '');
      return true;
    },
    overageDebitNetCents: () => 50,
    reconcileOverageDebit: () => true,
    countRecentFailedRuns: () => 2,
  };
  return {
    review: {
      job: { deep: false, installationId: 1, owner: 'acme', repo: 'api', pr: 1 },
      config: { store },
      runId: 'run-1',
      startedAt: 1,
      plan: { overageCentsPerReview: 50 },
    } as never,
    completed,
    refunds,
  };
}

test('undelivered review result refunds prepaid overage even after provider spend', async () => {
  const { review, completed, refunds } = admittedReview();
  const service = new FinalizationService({
    now: () => 2,
    postFailureNotice: async () => undefined,
  });
  await service.complete(review, {
    findingCount: 0,
    newCount: 0,
    fixedCount: 0,
    skipReason: 'provider_timeout',
    inputTokens: 10,
    outputTokens: 5,
    costUsd: 0.1,
  });
  assert.equal((completed[0] as { status: string }).status, 'failed');
  assert.equal(refunds.length, 1);
});

test('thrown provider failure refunds prepaid overage even when usage was recorded', async () => {
  const { review, refunds } = admittedReview();
  const service = new FinalizationService({
    now: () => 2,
    postFailureNotice: async () => undefined,
  });
  await assert.rejects(service.fail(review, new Error('provider failed')), /provider failed/);
  assert.equal(refunds.length, 1);
});

test('published partial output remains completed and records its limitation', async () => {
  const { review, completed, refunds } = admittedReview();
  const service = new FinalizationService({
    now: () => 2,
    postFailureNotice: async () => undefined,
  });
  await service.complete(review, {
    findingCount: 1,
    newCount: 1,
    fixedCount: 0,
    incompleteReason: 'review incomplete: 1/4 required review coverage unit(s) did not complete',
    inputTokens: 10,
    outputTokens: 5,
    costUsd: 0.1,
    published: true,
  });
  assert.deepEqual(completed[0], {
    status: 'completed',
    skipReason: undefined,
    error: 'review incomplete: 1/4 required review coverage unit(s) did not complete',
    durationMs: 1,
    findingsNew: 1,
    findingsFixed: 0,
    findingsOpen: 1,
    inputTokens: 10,
    outputTokens: 5,
    costUsd: 0.1,
    newFindings: undefined,
    deep: false,
  });
  assert.equal(refunds.length, 0);
});
