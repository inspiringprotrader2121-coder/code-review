import { Redis } from 'ioredis';
import {
  jobIdempotencyKey,
  prKey,
  type EnqueueResult,
  type ReviewJobPayload,
  type ReviewQueue,
} from './types.js';

const QUEUE_KEY = 'orvex-review:jobs';
const SEEN_PREFIX = 'orvex-review:seen:';
const DONE_PREFIX = 'orvex-review:done:';
const INFLIGHT_PREFIX = 'orvex-review:inflight:';
const PENDING_PREFIX = 'orvex-review:pending:';

// Atomic coalesce: a review replaces the LAST review already in the pending list
// (scanning from the tail); anything else appends. cjson decode is wrapped in
// pcall so a malformed entry never aborts the script. Shared by the enqueue and
// dequeue-claim scripts below — it does NOT return, so callers control the
// script's own return value. Expects: pending list key in KEYS[2], raw job in
// ARGV[1], kind in ARGV[2].
const COALESCE_SNIPPET = `
local coalesced = 0
if ARGV[2] == 'review' then
  local list = redis.call('LRANGE', KEYS[2], 0, -1)
  for i = #list, 1, -1 do
    local k = 'review'
    local ok, d = pcall(cjson.decode, list[i])
    if ok and d and d.kind then k = d.kind end
    if k == 'review' then
      redis.call('LSET', KEYS[2], i - 1, ARGV[1])
      coalesced = 1
      break
    end
  end
end
if coalesced == 0 then
  redis.call('RPUSH', KEYS[2], ARGV[1])
end`;

// ATOMIC enqueue decision (closes the enqueue→coalesce TOCTOU): check the PR's
// inflight lock and either coalesce into pending or push to the main queue as
// ONE Redis step. With a non-atomic check-then-act, a job could land in pending
// AFTER the worker's final drain ran — stranded forever (nothing drains pending
// once the PR goes idle). Serialized against the drain, every interleaving is
// safe: lock held → pending (the drain pops it); lock gone → main queue.
// KEYS[1]=inflight key, KEYS[2]=pending list, KEYS[3]=main queue.
// ARGV[1]=raw job json, ARGV[2]=kind.
const ENQUEUE_LUA = `
if redis.call('EXISTS', KEYS[1]) == 1 then
  ${COALESCE_SNIPPET}
  return 'coalesced'
end
redis.call('RPUSH', KEYS[3], ARGV[1])
return 'enqueued'`;

// ATOMIC dequeue claim: claim the PR's inflight lock, or — if a run for this PR
// is already in flight — coalesce into pending, as ONE step (same TOCTOU as
// enqueue: a non-atomic claim-then-stash could strand the job behind a drain
// that already ran).
// KEYS[1]=inflight key, KEYS[2]=pending list. ARGV[1]=raw job, ARGV[2]=kind,
// ARGV[3]=lock TTL seconds.
const CLAIM_LUA = `
local ok = redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[3], 'NX')
if ok then return 'claimed' end
${COALESCE_SNIPPET}
return 'pending'`;

// Compare-and-delete: DEL the key only if it still holds our exact value.
const CASDEL_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0`;

// Crash-loop guard for startup recovery: a job that kills the worker (OOM, native
// crash) would otherwise be requeued by recoverOrphans on EVERY restart and crash
// it again forever. Count how many times each job has been resumed after a
// restart; past the cap, drop it with a loud log instead of requeueing.
const RESUMED_PREFIX = 'orvex-review:resumed:';
const MAX_RESUME_AFTER_RESTART = Math.max(
  0,
  Number(process.env.ORVEX_MAX_RESUME_AFTER_RESTART ?? 2) || 2,
);

export class RedisReviewQueue implements ReviewQueue {
  private redis: Redis;

  constructor(url: string) {
    this.redis = new Redis(url);
  }

  async enqueue(job: ReviewJobPayload): Promise<EnqueueResult> {
    const idKey = jobIdempotencyKey(job);
    const pk = prKey(job);

    // Already completed this exact job? reject.
    if (await this.redis.exists(`${DONE_PREFIX}${idKey}`)) {
      return { accepted: false, jobId: idKey, reason: 'duplicate' };
    }

    // Atomically CLAIM the idempotency key: `SET NX` returns null if it already
    // existed. This closes the check-then-set race the old exists()+set() had —
    // GitHub redelivers webhooks on timeout, and two identical deliveries hitting
    // the endpoint concurrently would both pass a plain exists() and both enqueue.
    const claimed = await this.redis.set(`${SEEN_PREFIX}${idKey}`, '1', 'EX', 86400, 'NX');
    if (claimed === null) {
      return { accepted: false, jobId: idKey, reason: 'duplicate' };
    }

    const raw = JSON.stringify(job);
    const kind = job.kind ?? 'review';
    // ONE atomic step: inflight → coalesce to pending, else → main queue.
    const result = await this.redis.eval(
      ENQUEUE_LUA,
      3,
      `${INFLIGHT_PREFIX}${pk}`,
      `${PENDING_PREFIX}${pk}`,
      QUEUE_KEY,
      raw,
      kind,
    );
    return { accepted: true, jobId: idKey, reason: result === 'coalesced' ? 'coalesced' : 'enqueued' };
  }

  async dequeue(): Promise<ReviewJobPayload | null> {
    // Return the first genuinely-runnable job, skipping (a) SHAs already reviewed
    // and (b) PRs already being processed. Bounded so a queue full of duplicates
    // can't spin forever.
    for (let i = 0; i < 50; i++) {
      const raw = await this.redis.lpop(QUEUE_KEY);
      if (!raw) return null;
      const job = JSON.parse(raw) as ReviewJobPayload;
      const pk = prKey(job);

      // Already completed this exact review (same SHA/action)? never re-review it.
      if (await this.redis.exists(`${DONE_PREFIX}${jobIdempotencyKey(job)}`)) continue;

      // Claim the PR atomically. If a review for this PR is ALREADY running, do
      // NOT start a second one concurrently — stash this as the pending "latest"
      // so it runs once, after the current one finishes. Claim-or-stash runs as
      // ONE Lua step (SET NX + coalesce): a non-atomic claim-then-stash could
      // land in pending after the in-flight run's final drain, stranding the job.
      // Store the PAYLOAD as the lock value (not just headSha) so a hard crash
      // can recover the in-flight job, and so completion can compare-and-delete
      // only ITS OWN lock. 2h TTL comfortably outlives even a deep review (each
      // call is wall-clock-capped upstream).
      const claimed = await this.redis.eval(
        CLAIM_LUA,
        2,
        `${INFLIGHT_PREFIX}${pk}`,
        `${PENDING_PREFIX}${pk}`,
        raw,
        job.kind ?? 'review',
        7200,
      );
      if (claimed === 'pending') continue;
      return job;
    }
    return null;
  }

  async markCompleted(job: ReviewJobPayload): Promise<void> {
    const idKey = jobIdempotencyKey(job);
    await this.redis.set(`${DONE_PREFIX}${idKey}`, '1', 'EX', 604800);
    // Compare-and-delete: only release the lock if it is STILL ours. If this
    // review outran its TTL and another run re-claimed the PR, an unconditional
    // DEL would delete the new run's lock and let a third run start concurrently.
    await this.redis.eval(CASDEL_LUA, 1, `${INFLIGHT_PREFIX}${prKey(job)}`, JSON.stringify(job));
  }

  async markFailed(job: ReviewJobPayload, _error: string): Promise<void> {
    const idKey = jobIdempotencyKey(job);
    await this.redis.del(`${SEEN_PREFIX}${idKey}`);
    await this.redis.eval(CASDEL_LUA, 1, `${INFLIGHT_PREFIX}${prKey(job)}`, JSON.stringify(job));
  }

  async releaseLockAndDrain(prKeyStr: string): Promise<ReviewJobPayload | null> {
    const raw = await this.redis.lpop(`${PENDING_PREFIX}${prKeyStr}`);
    if (!raw) return null;

    const job = JSON.parse(raw) as ReviewJobPayload;
    await this.redis.rpush(QUEUE_KEY, JSON.stringify(job));
    return job;
  }

  /**
   * Startup recovery. After a restart NOTHING is genuinely in-flight, so any
   * leftover `inflight:` locks are stale — and while they exist, enqueue coalesces
   * new pushes for that PR into `pending:` and they never run (nothing drains
   * pending unless a job completes). This clears stale inflight locks and moves
   * any pending jobs back onto the main queue so no PR is left blocked. Call once
   * at startup before the worker loop starts.
   */
  async recoverOrphans(): Promise<number> {
    // After a restart NOTHING is genuinely in-flight, so a leftover inflight lock
    // is a review that was cut off mid-run (hard crash / SIGKILL). The lock value
    // is the full job payload — REQUEUE it (clearing its dedup marker) before
    // deleting the lock, so a crashed review is never lost, then the PR unblocks.
    const inflight = await this.redis.keys(`${INFLIGHT_PREFIX}*`);
    let recovered = 0;
    for (const key of inflight) {
      const raw = await this.redis.get(key);
      if (raw) {
        try {
          const job = JSON.parse(raw) as ReviewJobPayload;
          // don't requeue a job that already finished (its DONE marker survived)
          if (!(await this.redis.exists(`${DONE_PREFIX}${jobIdempotencyKey(job)}`))) {
            // CRASH-LOOP GUARD: a job that KILLS the worker (OOM, native crash)
            // comes back here on every restart and would crash it again forever.
            // Count resumes; past the cap, drop the job loudly instead.
            const idKey = jobIdempotencyKey(job);
            const resumes = await this.redis.incr(`${RESUMED_PREFIX}${idKey}`);
            await this.redis.expire(`${RESUMED_PREFIX}${idKey}`, 86400);
            if (resumes > MAX_RESUME_AFTER_RESTART) {
              console.error(
                `[queue] DROPPING job ${idKey} — resumed ${resumes}x after restarts (cap ${MAX_RESUME_AFTER_RESTART}); it appears to crash the worker. Investigate manually.`,
              );
            } else {
              await this.redis.del(`${SEEN_PREFIX}${idKey}`);
              await this.redis.rpush(QUEUE_KEY, raw);
              recovered++;
            }
          }
        } catch {
          /* malformed lock value — just drop the lock */
        }
      }
      await this.redis.del(key);
    }

    let requeued = recovered;
    const pendingKeys = await this.redis.keys(`${PENDING_PREFIX}*`);
    for (const key of pendingKeys) {
      for (;;) {
        const raw = await this.redis.lpop(key);
        if (!raw) break;
        // clear the dedup marker so the requeued job is accepted, then queue it
        try {
          const job = JSON.parse(raw) as ReviewJobPayload;
          await this.redis.del(`${SEEN_PREFIX}${jobIdempotencyKey(job)}`);
        } catch {
          /* keep going even if one entry is malformed */
        }
        await this.redis.rpush(QUEUE_KEY, raw);
        requeued++;
      }
    }
    return requeued; // recovered in-flight + drained pending
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.redis.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}
