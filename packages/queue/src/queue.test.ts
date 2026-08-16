import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryReviewQueue } from './memory.js';
import { jobIdempotencyKey, queueFailure, DEQUEUE_INSPECTION_WINDOW, type ReviewJobPayload } from './types.js';

function job(overrides: Partial<ReviewJobPayload> = {}): ReviewJobPayload {
  return {
    installationId: 1,
    tenantId: 't',
    owner: 'acme',
    repo: 'api',
    pr: 5,
    headSha: 'sha1',
    action: 'synchronize',
    enqueuedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

test('never runs a SECOND review while one is already in-flight for the same PR', async () => {
  const q = new MemoryReviewQueue();
  await q.enqueue(job({ headSha: 'sha1', action: 'manual' }));
  await q.enqueue(job({ headSha: 'sha2', action: 'manual' })); // different SHA, same PR

  const first = await q.dequeue();
  assert.ok(first, 'first review dequeues and claims the PR');
  // The PR is now in-flight — the second must NOT come out concurrently.
  const second = await q.dequeue();
  assert.equal(second, null, 'no second concurrent review for the same PR');
});

test('the coalesced review runs (once) AFTER the first completes — reviewing the latest SHA', async () => {
  const q = new MemoryReviewQueue();
  await q.enqueue(job({ headSha: 'sha1', action: 'manual' }));
  await q.enqueue(job({ headSha: 'sha2', action: 'manual' }));
  const first = await q.dequeue();
  assert.equal(await q.dequeue(), null); // sha2 coalesced to pending

  await q.markCompleted(first!);
  const drained = await q.releaseLockAndDrain('1/acme/api#5');
  assert.ok(drained, 'the pending latest is drained back onto the queue');
  const next = await q.dequeue();
  assert.equal(next?.headSha, 'sha2', 'the LATEST queued SHA is the one that runs');
});

test('a SHA already completed is never re-reviewed (dequeue skips it)', async () => {
  const q = new MemoryReviewQueue();
  const j = job({ headSha: 'shaX', action: 'synchronize' });
  const j2 = { ...j }; // a duplicate enqueue of the same review
  const first = await q.dequeue.call(q); // empty
  assert.equal(first, null);
  await q.enqueue(j);
  const run = await q.dequeue();
  await q.markCompleted(run!);
  // now a duplicate of the same SHA lands on the queue (e.g. a re-delivery)
  q['state'].queue.push(j2); // simulate a raw re-enqueue bypassing dedup
  const again = await q.dequeue();
  assert.equal(again, null, 'the already-completed SHA is skipped, not re-reviewed');
});

test('different PRs are unaffected — each still runs concurrently', async () => {
  const q = new MemoryReviewQueue();
  await q.enqueue(job({ pr: 1, action: 'manual' }));
  await q.enqueue(job({ pr: 2, action: 'manual' }));
  const a = await q.dequeue();
  const b = await q.dequeue();
  assert.ok(a && b, 'two different PRs both dequeue');
  assert.notEqual(a!.pr, b!.pr);
});

test('dequeue honors plan priority while preserving FIFO within one tier', async () => {
  const q = new MemoryReviewQueue();
  await q.enqueue(job({ pr: 1, headSha: 'low', action: 'manual', priority: 0 }));
  await q.enqueue(job({ pr: 2, headSha: 'high-first', action: 'manual', priority: 3 }));
  await q.enqueue(job({ pr: 3, headSha: 'high-second', action: 'manual', priority: 3 }));

  assert.equal((await q.dequeue())?.headSha, 'high-first');
  assert.equal((await q.dequeue())?.headSha, 'high-second');
  assert.equal((await q.dequeue())?.headSha, 'low');
});

test('ready_for_review is not deduped against a prior draft opened skip on the same SHA', async () => {
  const q = new MemoryReviewQueue();
  const opened = job({ headSha: 'shaDraft', action: 'opened' });
  await q.enqueue(opened);
  const run = await q.dequeue();
  // Draft skip must NOT mark the bare SHA DONE — only :draft_skipped.
  await q.markCompleted(run!, { draftSkipped: true });

  const ready = await q.enqueue(job({ headSha: 'shaDraft', action: 'ready_for_review' }));
  assert.equal(ready.accepted, true, 'ready_for_review must not collide with draft skip');
  const next = await q.dequeue();
  assert.equal(next?.action, 'ready_for_review');
});

test('ready_for_review is deduped when opened already successfully reviewed the same SHA', async () => {
  const q = new MemoryReviewQueue();
  await q.enqueue(job({ headSha: 'shaReady', action: 'opened' }));
  const run = await q.dequeue();
  await q.markCompleted(run!); // full review, bare SHA DONE

  const ready = await q.enqueue(job({ headSha: 'shaReady', action: 'ready_for_review' }));
  assert.equal(ready.accepted, false, 'ready_for_review must not double-review after opened');
  assert.equal(ready.reason, 'duplicate');
});

test('opened is deduped when ready_for_review already successfully reviewed the same SHA', async () => {
  const q = new MemoryReviewQueue();
  await q.enqueue(job({ headSha: 'shaReady2', action: 'ready_for_review' }));
  const run = await q.dequeue();
  await q.markCompleted(run!); // also marks bare SHA DONE

  const opened = await q.enqueue(job({ headSha: 'shaReady2', action: 'opened' }));
  assert.equal(opened.accepted, false, 'opened must not double-review after ready_for_review');
  assert.equal(opened.reason, 'duplicate');
});

test('reopened coalesces behind a close-aborted same-SHA review and then runs', async () => {
  const q = new MemoryReviewQueue();
  await q.enqueue(job({ headSha: 'shaReopen', action: 'opened' }));
  const opened = await q.dequeue();
  assert.ok(opened);

  const reopened = await q.enqueue(
    job({
      headSha: 'shaReopen',
      action: 'reopened',
      enqueuedAt: '2026-01-01T00:01:00Z',
    }),
  );
  assert.equal(reopened.accepted, true);
  assert.equal(reopened.reason, 'coalesced');

  await q.markFailed(opened!, queueFailure('pr_closed', 'pr_closed_mid_run'));
  await q.releaseLockAndDrain('1/acme/api#5');
  assert.equal((await q.dequeue())?.action, 'reopened');
});

test('reopened stays deduped after a successful same-SHA review', async () => {
  const q = new MemoryReviewQueue();
  await q.enqueue(job({ headSha: 'shaDone', action: 'opened' }));
  const opened = await q.dequeue();
  await q.markCompleted(opened!);

  const reopened = await q.enqueue(job({ headSha: 'shaDone', action: 'reopened' }));
  assert.equal(reopened.accepted, false);
  assert.equal(reopened.reason, 'duplicate');
});

test('a queue without leases is safe to heartbeat (optional-method contract)', async () => {
  // queue-runner heartbeats via `queue.renewLease?.(job)`. MemoryReviewQueue is
  // single-process and has no lease, so the method is absent — the optional call
  // must stay a no-op rather than throwing inside the review loop.
  const q = new MemoryReviewQueue();
  const j = job();
  const optional = q as { renewLease?: (x: ReviewJobPayload) => Promise<void> };
  assert.equal(optional.renewLease, undefined, 'memory queue has no lease to renew');
  await assert.doesNotReject(async () => {
    await optional.renewLease?.(j);
  });
});

test('nightly scans are idempotent for a repo within one UTC day', () => {
  const first = job({
    kind: 'scan',
    action: 'command',
    pr: 0,
    headSha: 'nightly',
    scanDay: '2026-08-06',
    enqueuedAt: '2026-08-06T03:00:00Z',
  });
  const retry = { ...first, enqueuedAt: '2026-08-06T03:45:00Z' };
  const nextDay = { ...first, scanDay: '2026-08-07', enqueuedAt: '2026-08-07T03:00:00Z' };
  assert.equal(jobIdempotencyKey(first), jobIdempotencyKey(retry));
  assert.notEqual(jobIdempotencyKey(first), jobIdempotencyKey(nextDay));
});

test('webhook command retries reuse a stable source idempotency key', async () => {
  const q = new MemoryReviewQueue();
  const first = job({
    kind: 'ask',
    action: 'command',
    sourceEventId: 'github-delivery-1',
    enqueuedAt: '2026-08-06T03:00:00Z',
  });
  const retry = { ...first, enqueuedAt: '2026-08-06T03:01:00Z' };
  assert.equal(jobIdempotencyKey(first), jobIdempotencyKey(retry));
  assert.equal((await q.enqueue(first)).accepted, true);
  assert.equal((await q.enqueue(retry)).accepted, false);
});

test('memory queue exposes the explicit lifecycle state machine', async () => {
  const q = new MemoryReviewQueue();
  const payload = job({ headSha: 'stateful', action: 'manual' });
  const id = jobIdempotencyKey(payload);
  assert.equal(await q.getJobState(id), null);
  await q.enqueue(payload);
  assert.equal(await q.getJobState(id), 'ready');
  const claimed = await q.dequeue();
  assert.equal(await q.getJobState(id), 'claimed');
  assert.equal(await q.markRunning(claimed!), true);
  assert.equal(await q.getJobState(id), 'running');
  await q.markCompleted(claimed!);
  assert.equal(await q.getJobState(id), 'succeeded');
});

test('terminal failures enter a durable operator queue and replay exactly once', async () => {
  const q = new MemoryReviewQueue();
  const payload = job({ headSha: 'terminal', action: 'manual' });
  await q.enqueue(payload);
  const claimed = await q.dequeue();
  assert.ok(claimed);
  await q.markRunning(claimed!);
  assert.equal(
    await q.markFailed(claimed!, queueFailure('execution_failed', 'provider exhausted')),
    true,
  );
  assert.equal(await q.getJobState(jobIdempotencyKey(payload)), 'dead-lettered');
  const [record] = await q.listDeadLetters!();
  assert.ok(record);
  assert.equal(record.reason, 'execution_failed');
  assert.deepEqual(q.drainOperationalEvents!(), [
    { type: 'dead-lettered', record, source: 'terminal-failure' },
  ]);
  assert.deepEqual(q.drainOperationalEvents!(), []);
  assert.equal(await q.replayDeadLetter!(record.id), true);
  assert.equal(await q.replayDeadLetter!(record.id), false);
  assert.equal(await q.getJobState(jobIdempotencyKey(payload)), 'ready');
  assert.deepEqual(await q.dequeue(), payload);
});

test('retryable failures remain replayable by the worker and are not dead-lettered', async () => {
  const q = new MemoryReviewQueue();
  const payload = job({ headSha: 'retryable', action: 'manual' });
  await q.enqueue(payload);
  const claimed = await q.dequeue();
  assert.ok(claimed);
  await q.markFailed(claimed!, queueFailure('provider_transient', 'retry', true));
  assert.equal(await q.getJobState(jobIdempotencyKey(payload)), 'failed');
  assert.deepEqual(await q.listDeadLetters!(), []);
  assert.deepEqual(q.drainOperationalEvents!(), []);
  assert.equal((await q.enqueue(payload)).accepted, true);
});

test('returnToQueue preserves age and does not mark the job failed', async () => {
  const q = new MemoryReviewQueue();
  const payload = job({ headSha: 'wait-not-fail', action: 'opened' });
  await q.enqueue(payload);
  const claimed = await q.dequeue();
  assert.ok(claimed);
  assert.equal(await q.markRunning(claimed!), true);
  assert.equal(await q.returnToQueue(claimed!), 'requeued');
  assert.equal(await q.getJobState(jobIdempotencyKey(payload)), 'ready');
  assert.deepEqual(await q.listDeadLetters!(), []);
  const again = await q.dequeue();
  assert.equal(again?.headSha, payload.headSha);
  assert.equal(again?.enqueuedAt, payload.enqueuedAt);
  assert.equal(again?.attempts, undefined);
  await q.markCompleted(again!);
});

test('dequeue inspects 256 ready jobs so a later eligible job is still claimed', async () => {
  const q = new MemoryReviewQueue();
  for (let index = 0; index < 200; index++) {
    await q.enqueue(
      job({
        pr: index + 1,
        headSha: `low-${index}`,
        action: 'manual',
        priority: 0,
      }),
    );
  }
  await q.enqueue(
    job({
      pr: 900,
      headSha: 'high-behind-window',
      action: 'manual',
      priority: 9,
    }),
  );
  assert.ok(200 < DEQUEUE_INSPECTION_WINDOW);
  assert.equal((await q.dequeue())?.headSha, 'high-behind-window');
});
