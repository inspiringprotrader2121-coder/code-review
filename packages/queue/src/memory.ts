import {
  jobIdempotencyKey,
  prKey,
  type EnqueueResult,
  type ReviewJobPayload,
  type ReviewQueue,
} from './types.js';

interface MemoryState {
  seen: Set<string>;
  completed: Set<string>;
  queue: ReviewJobPayload[];
  inFlight: Map<string, ReviewJobPayload>;
  pending: Map<string, ReviewJobPayload>;
}

export class MemoryReviewQueue implements ReviewQueue {
  private state: MemoryState = {
    seen: new Set(),
    completed: new Set(),
    queue: [],
    inFlight: new Map(),
    pending: new Map(),
  };

  async enqueue(job: ReviewJobPayload): Promise<EnqueueResult> {
    const idKey = jobIdempotencyKey(job);
    const pk = prKey(job);

    if (this.state.completed.has(idKey) || this.state.seen.has(idKey)) {
      return { accepted: false, jobId: idKey, reason: 'duplicate' };
    }

    this.state.seen.add(idKey);

    if (this.state.inFlight.has(pk)) {
      this.state.pending.set(pk, job);
      return { accepted: true, jobId: idKey, reason: 'coalesced' };
    }

    this.state.queue.push(job);
    return { accepted: true, jobId: idKey, reason: 'enqueued' };
  }

  async dequeue(): Promise<ReviewJobPayload | null> {
    const job = this.state.queue.shift();
    if (!job) return null;

    this.state.inFlight.set(prKey(job), job);
    return job;
  }

  async markCompleted(job: ReviewJobPayload): Promise<void> {
    const idKey = jobIdempotencyKey(job);
    this.state.completed.add(idKey);
    this.state.inFlight.delete(prKey(job));
  }

  async markFailed(job: ReviewJobPayload, _error: string): Promise<void> {
    const idKey = jobIdempotencyKey(job);
    this.state.seen.delete(idKey);
    this.state.inFlight.delete(prKey(job));
  }

  async releaseLockAndDrain(prKeyStr: string): Promise<ReviewJobPayload | null> {
    const pending = this.state.pending.get(prKeyStr);
    if (!pending) return null;

    this.state.pending.delete(prKeyStr);
    this.state.queue.push(pending);
    return pending;
  }

  async close(): Promise<void> {
    // no-op
  }
}
