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
  // a per-PR pending LIST, not a single slot: coalescing consecutive reviews is
  // fine, but a fix/ask/resolve command must never be overwritten by a later
  // review (or vice versa).
  pending: Map<string, ReviewJobPayload[]>;
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
      const list = this.state.pending.get(pk) ?? [];
      const kind = job.kind ?? 'review';
      const last = list[list.length - 1];
      // collapse only a review-after-review; keep every command distinct
      if (kind === 'review' && last && (last.kind ?? 'review') === 'review') {
        list[list.length - 1] = job;
      } else {
        list.push(job);
      }
      this.state.pending.set(pk, list);
      return { accepted: true, jobId: idKey, reason: 'coalesced' };
    }

    this.state.queue.push(job);
    return { accepted: true, jobId: idKey, reason: 'enqueued' };
  }

  async dequeue(): Promise<ReviewJobPayload | null> {
    // Mirror the Redis queue: skip already-completed SHAs, and never start a
    // second review while one is already in-flight for the same PR (coalesce it
    // to pending instead).
    for (let i = 0; i < 50; i++) {
      const job = this.state.queue.shift();
      if (!job) return null;
      const pk = prKey(job);

      if (this.state.completed.has(jobIdempotencyKey(job))) continue;

      if (this.state.inFlight.has(pk)) {
        const list = this.state.pending.get(pk) ?? [];
        const kind = job.kind ?? 'review';
        const last = list[list.length - 1];
        if (kind === 'review' && last && (last.kind ?? 'review') === 'review') {
          list[list.length - 1] = job; // keep only the latest review
        } else {
          list.push(job);
        }
        this.state.pending.set(pk, list);
        continue;
      }

      this.state.inFlight.set(pk, job);
      return job;
    }
    return null;
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
    const list = this.state.pending.get(prKeyStr);
    if (!list || list.length === 0) return null;

    const next = list.shift()!;
    if (list.length === 0) this.state.pending.delete(prKeyStr);
    else this.state.pending.set(prKeyStr, list);

    this.state.queue.push(next);
    return next;
  }

  async recoverOrphans(): Promise<number> {
    // In-memory state is lost on restart, so there is nothing stale to recover.
    return 0;
  }

  async ping(): Promise<boolean> {
    return true; // in-process — always reachable
  }

  async close(): Promise<void> {
    // no-op
  }
}
