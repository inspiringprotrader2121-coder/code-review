import assert from 'node:assert/strict';
import test from 'node:test';
import {
  finalizeQueueJob,
  resolveWorkerConcurrency,
  withAgenticReviewSlot,
} from './queue-runner.js';
import type { ReviewJobPayload, ReviewQueue } from '@orvex-review/queue';

test('worker concurrency is not reduced for lower-tier reviews', () => {
  assert.equal(resolveWorkerConcurrency({ ORVEX_MAX_CONCURRENT_REVIEWS: '4' }), 4);
  assert.equal(
    resolveWorkerConcurrency({
      ORVEX_MAX_CONCURRENT_REVIEWS: '4',
      ORVEX_CODEX_CLI: '1',
    }),
    4,
  );
});

test('agentic reviews serialize while non-agentic work bypasses the Luna gate', async () => {
  let markFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    markFirstStarted = resolve;
  });
  let releaseFirst!: () => void;
  const firstCanFinish = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const events: string[] = [];

  const first = withAgenticReviewSlot(true, async () => {
    events.push('agentic-1-start');
    markFirstStarted();
    await firstCanFinish;
    events.push('agentic-1-end');
  });
  await firstStarted;
  const second = withAgenticReviewSlot(true, async () => {
    events.push('agentic-2-start');
    events.push('agentic-2-end');
  });
  const lowerTier = withAgenticReviewSlot(false, async () => {
    events.push('lower-tier');
  });

  await lowerTier;
  assert.deepEqual(events, ['agentic-1-start', 'lower-tier']);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, [
    'agentic-1-start',
    'lower-tier',
    'agentic-1-end',
    'agentic-2-start',
    'agentic-2-end',
  ]);
});

test('close-aborted reviews clear queue dedup instead of being marked completed', async () => {
  const calls: string[] = [];
  const queue = {
    markCompleted: async () => {
      calls.push('completed');
    },
    markFailed: async (_job: ReviewJobPayload, error: string) => {
      calls.push(`failed:${error}`);
    },
  } as Pick<ReviewQueue, 'markCompleted' | 'markFailed'>;
  const job = {
    installationId: 1,
    tenantId: 't',
    owner: 'acme',
    repo: 'api',
    pr: 1,
    headSha: 'abc',
    action: 'opened',
    enqueuedAt: new Date().toISOString(),
  } satisfies ReviewJobPayload;

  await finalizeQueueJob(queue, job, { draftSkipped: false, prClosedMidRun: true });
  assert.deepEqual(calls, ['failed:pr_closed_mid_run']);
});
