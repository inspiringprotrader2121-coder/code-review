import {
  automaticReviewAlreadyDone,
  draftSkipIdempotencyKey,
  jobIdempotencyKey,
  prKey,
  reviewShaIdempotencyKey,
  type EnqueueResult,
  type MarkCompletedOptions,
  type ReviewJobPayload,
  type ReviewQueue,
} from './types.js';

/** Add a job to a PR's pending list. A review SUPERSEDES the last queued review
 *  (not merely the last element) — otherwise `[review(sha1), fix]` + review(sha2)
 *  leaves BOTH reviews, and the stale sha1 review later runs against old code.
 *  Commands are always kept distinct. */
function pushCoalesced(list: ReviewJobPayload[], job: ReviewJobPayload): ReviewJobPayload | undefined {
  if ((job.kind ?? 'review') === 'review') {
    const idx = list.map((j) => j.kind ?? 'review').lastIndexOf('review');
    if (idx >= 0) {
      const superseded = list[idx];
      list[idx] = job; // keep only the latest review SHA
      return superseded;
    }
  }
  list.push(job);
  return undefined;
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
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 1_000_000) : 20_000;
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

    if (
      automaticReviewAlreadyDone(job, (k) => this.state.completed.has(k)) ||
      this.state.seen.has(idKey)
    ) {
      return { accepted: false, jobId: idKey, reason: 'duplicate' };
    }

    this.state.seen.add(idKey);
    trimSet(this.state.seen);

    if (this.state.inFlight.has(pk)) {
      const list = this.state.pending.get(pk) ?? [];
      const superseded = pushCoalesced(list, job);
      if (superseded && superseded.action !== 'command' && superseded.action !== 'manual') {
        this.state.seen.delete(jobIdempotencyKey(superseded));
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
      const window = Math.min(50, this.state.queue.length);
      let selected = 0;
      let selectedPriority = Number.NEGATIVE_INFINITY;
      for (let index = 0; index < window; index++) {
        const priority = Number.isFinite(this.state.queue[index]?.priority)
          ? Math.floor(this.state.queue[index]!.priority!)
          : 0;
        if (priority > selectedPriority) {
          selected = index;
          selectedPriority = priority;
        }
      }
      const [job] = this.state.queue.splice(selected, 1);
      if (!job) return null;
      const pk = prKey(job);

      if (automaticReviewAlreadyDone(job, (k) => this.state.completed.has(k))) continue;

      if (this.state.inFlight.has(pk)) {
        const list = this.state.pending.get(pk) ?? [];
        const superseded = pushCoalesced(list, job);
        if (superseded && superseded.action !== 'command' && superseded.action !== 'manual') {
          this.state.seen.delete(jobIdempotencyKey(superseded));
        }
        this.state.pending.set(pk, list);
        continue;
      }

      this.state.inFlight.set(pk, job);
      return job;
    }
    return null;
  }

  async markCompleted(job: ReviewJobPayload, opts?: MarkCompletedOptions): Promise<boolean> {
    if (this.state.inFlight.get(prKey(job)) !== job) return false;
    if (opts?.draftSkipped) {
      this.state.completed.add(draftSkipIdempotencyKey(job));
      trimSet(this.state.completed);
      this.state.inFlight.delete(prKey(job));
      return true;
    }
    const idKey = jobIdempotencyKey(job);
    this.state.completed.add(idKey);
    // ready_for_review uses a distinct SEEN key; also mark the bare SHA so a
    // queued `opened` for the same head cannot double-review after ready ran.
    const bare = reviewShaIdempotencyKey(job);
    if (idKey !== bare && (job.kind ?? 'review') === 'review') {
      this.state.completed.add(bare);
    }
    trimSet(this.state.completed);
    this.state.inFlight.delete(prKey(job));
    return true;
  }

  async markFailed(job: ReviewJobPayload, _error: string): Promise<boolean> {
    if (this.state.inFlight.get(prKey(job)) !== job) return false;
    const idKey = jobIdempotencyKey(job);
    this.state.seen.delete(idKey);
    this.state.inFlight.delete(prKey(job));
    return true;
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

  /** Memory queue already holds the live job object in `inFlight`, so mutations
   *  like `runId` are visible without a separate persist step. */
  async persistJob(_job: ReviewJobPayload): Promise<void> {
    // no-op — WeakMap/Map store the same object reference
  }

  async depth(): Promise<import('./types.js').QueueDepth> {
    let waitingOnPr = 0;
    for (const list of this.state.pending.values()) waitingOnPr += list.length;
    let oldestQueuedAt: string | null = null;
    for (const job of this.state.queue) {
      if (!oldestQueuedAt || job.enqueuedAt < oldestQueuedAt) oldestQueuedAt = job.enqueuedAt;
    }
    return {
      queued: this.state.queue.length,
      waitingOnPr,
      inFlight: this.state.inFlight.size,
      oldestQueuedAt,
    };
  }

  async ping(): Promise<boolean> {
    return true; // in-process — always reachable
  }

  async close(): Promise<void> {
    // no-op
  }
}
