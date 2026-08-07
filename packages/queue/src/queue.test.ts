import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryReviewQueue } from './memory.js';
import { jobIdempotencyKey, type ReviewJobPayload } from './types.js';

function job(overrides: Partial<ReviewJobPayload> = {}): ReviewJobPayload {
  return {
    installationId: 1, tenantId: 't', owner: 'acme', repo: 'api', pr: 5,
    headSha: 'sha1', action: 'synchronize', enqueuedAt: '2026-01-01T00:00:00Z',
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
  assert.equal((await q.dequeue()), null); // sha2 coalesced to pending

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
