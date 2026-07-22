import {
  jobIdempotencyKey,
  prKey,
  type EnqueueResult,
  type ReviewJobPayload,
  type ReviewQueue,
} from './types.js';

/** Add a job to a PR's pending list. A review SUPERSEDES the last queued review
 *  (not merely the last element) — otherwise `[review(sha1), fix]` + review(sha2)
 *  leaves BOTH reviews, and the stale sha1 review later runs against old code.
 *  Commands are always kept distinct. */
function pushCoalesced(list: ReviewJobPayload[], job: ReviewJobPayload): void {
  if ((job.kind ?? 'review') === 'review') {
    const idx = list.map((j) => j.kind ?? 'review').lastIndexOf('review');
    if (idx >= 0) {
      list[idx] = job; // keep only the latest review SHA
      return;
    }
  }
  list.push(job);
}

// The Redis backend TTLs its dedup keys; the in-memory sets have no expiry, so a
// long-lived worker leaks them. Cap and evict oldest (Set preserves insertion
// order) — matches Redis's bounded footprint. Dropping an ancient dedup key at
// worst allows a very old SHA to be re-reviewed, which is harmless.
// NaN-guard: a garbage ORVEX_QUEUE_MAX_DEDUP (e.g. "abc") makes `size <= NaN`
// false forever and trimSet would evict EVERY entry on each write, silently
// disabling dedup — fall back to the default on any non-positive/non-finite value.
const MAX_DEDUP_ENTRIES = (() => {
  const n = Number(process.env.ORVEX_QUEUE_MAX_DEDUP ?? 20_000);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 20_000;
})();
function trimSet(set: Set<string>): void {
  if (set.size <= MAX_DEDUP_ENTRIES) return;
  let drop = set.size - MAX_DEDUP_ENTRIES;
  for (const k of set) {
    set.delete(k);
    if (--drop <= 0) break;
  }
}

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
    trimSet(this.state.seen);

    if (this.state.inFlight.has(pk)) {
      const list = this.state.pending.get(pk) ?? [];
      pushCoalesced(list, job);
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
        pushCoalesced(list, job);
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
    trimSet(this.state.completed);
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
