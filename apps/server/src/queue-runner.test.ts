import assert from 'node:assert/strict';
import test from 'node:test';
import {
  failInterruptedJobs,
  finalizeQueueJob,
  returnLateDequeuedJob,
  resolveMaxJobRetries,
  resolveWorkerConcurrency,
  waitForReservedDequeues,
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

test('full failed reviews are not automatically replayed unless explicitly enabled', () => {
  assert.equal(resolveMaxJobRetries({}), 0);
  assert.equal(resolveMaxJobRetries({ ORVEX_MAX_JOB_RETRIES: '1' }), 1);
  assert.equal(resolveMaxJobRetries({ ORVEX_MAX_JOB_RETRIES: '20' }), 1);
  assert.equal(resolveMaxJobRetries({ ORVEX_MAX_JOB_RETRIES: 'invalid' }), 0);
});

test('restart interruption is failed without re-enqueuing paid stages', async () => {
  const marked: string[] = [];
  const interrupted: string[] = [];
  const job = {
    installationId: 1,
    tenantId: 'tenant',
    owner: 'owner',
    repo: 'repo',
    pr: 7,
    headSha: 'abc',
    action: 'opened',
    enqueuedAt: new Date(0).toISOString(),
    runId: 'run-1',
  } satisfies ReviewJobPayload;

  const count = await failInterruptedJobs(
    { async markFailed(_job, reason) { marked.push(reason); } },
    { interruptReviewRun(runId) { interrupted.push(runId); } },
    [job],
  );

  assert.equal(count, 1);
  assert.deepEqual(interrupted, ['run-1']);
  assert.deepEqual(marked, ['interrupted by restart']);
});

test('shutdown bounds its wait for a dequeue that never settles', async () => {
  const started = Date.now();
  const settled = await waitForReservedDequeues(() => 1, () => 0, 30, 5);
  const elapsed = Date.now() - started;

  assert.equal(settled, false);
  assert.ok(elapsed >= 20, `returned too early after ${elapsed}ms`);
  assert.ok(elapsed < 250, `shutdown handoff wait was not bounded (${elapsed}ms)`);
});

test('a late dequeue drains a newer coalesced SHA instead of requeueing the old one', async () => {
  const calls: string[] = [];
  const newer = {
    installationId: 1,
    tenantId: 'tenant',
    owner: 'owner',
    repo: 'repo',
    pr: 7,
    headSha: 'newer',
    action: 'synchronize',
    enqueuedAt: new Date(1).toISOString(),
  } satisfies ReviewJobPayload;
  const old = { ...newer, headSha: 'old', enqueuedAt: new Date(0).toISOString() };
  const queue = {
    async markFailed() { calls.push('failed-old'); },
    async releaseLockAndDrain() { calls.push('drained-newer'); return newer; },
    async enqueue() { calls.push('requeued-old'); return { accepted: true, jobId: 'old', reason: 'enqueued' as const }; },
  };

  assert.equal(await returnLateDequeuedJob(queue, old), 'newer-pending');
  assert.deepEqual(calls, ['failed-old', 'drained-newer']);
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
