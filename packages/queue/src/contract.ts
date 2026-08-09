import assert from 'node:assert/strict';
import {
  jobIdempotencyKey,
  prKey,
  queueFailure,
  type ReviewJobPayload,
  type ReviewQueue,
} from './types.js';

function contractJob(headSha: string, pr = 1): ReviewJobPayload {
  return {
    installationId: 99,
    tenantId: 'queue-contract',
    owner: 'orvex-contract',
    repo: 'queue',
    pr,
    headSha,
    action: 'opened',
    enqueuedAt: '2026-08-09T00:00:00.000Z',
  };
}

/** Black-box lifecycle contract shared by every ReviewQueue implementation. */
export async function assertReviewQueueContract(queue: ReviewQueue): Promise<void> {
  const first = contractJob('first');
  const id = jobIdempotencyKey(first);
  assert.equal((await queue.enqueue(first)).reason, 'enqueued');
  assert.equal(await queue.getJobState(id), 'ready');
  assert.equal((await queue.enqueue(first)).reason, 'duplicate');

  const claimed = await queue.dequeue();
  assert.deepEqual(claimed, first);
  assert.equal(await queue.getJobState(id), 'claimed');
  assert.equal(await queue.markRunning(claimed!), true);
  assert.equal(await queue.getJobState(id), 'running');

  const newer = { ...contractJob('newer'), action: 'synchronize' as const };
  assert.equal((await queue.enqueue(newer)).reason, 'coalesced');
  await queue.markCompleted(claimed!);
  assert.equal(await queue.getJobState(id), 'succeeded');
  assert.deepEqual(await queue.releaseLockAndDrain(prKey(first)), newer);

  const next = await queue.dequeue();
  assert.deepEqual(next, newer);
  assert.equal(await queue.markRunning(next!), true);
  await queue.markFailed(next!, queueFailure('execution_failed', 'contract retry', true));
  assert.equal(await queue.getJobState(jobIdempotencyKey(newer)), 'failed');
  assert.equal((await queue.enqueue(newer)).accepted, true);
}
