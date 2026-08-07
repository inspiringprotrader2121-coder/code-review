import { Redis } from 'ioredis';
import { createHash, randomUUID } from 'node:crypto';
import {
  draftSkipIdempotencyKey,
  jobIdempotencyKey,
  prKey,
  reviewShaIdempotencyKey,
  type EnqueueResult,
  type MarkCompletedOptions,
  type ReviewJobPayload,
  type ReviewQueue,
} from './types.js';

const QUEUE_KEY = 'orvex-review:jobs';
const SEEN_PREFIX = 'orvex-review:seen:';
const DONE_PREFIX = 'orvex-review:done:';
const INFLIGHT_PREFIX = 'orvex-review:inflight:';
const PENDING_PREFIX = 'orvex-review:pending:';
const PROCESSING_KEY = 'orvex-review:processing';
const PROCESSING_META_PREFIX = 'orvex-review:processing-meta:';
// Recovery runs periodically while workers are active. A longer grace covers
// the dequeue→claim handoff and a brief Redis/CPU stall without requeueing a
// payload that its original worker is still about to claim.
const PROCESSING_RECOVERY_GRACE_MS = 30_000;

// Atomic coalesce: a review replaces the LAST review already in the pending list
// (scanning from the tail); anything else appends. cjson decode is wrapped in
// pcall so a malformed entry never aborts the script. Shared by the enqueue and
// dequeue-claim scripts below — it does NOT return, so callers control the
// script's own return value. Expects: pending list key in KEYS[2], raw job in
// ARGV[1], kind in ARGV[2]. Claim callers pass the seen-key prefix in ARGV[5].
const COALESCE_SNIPPET = `
local coalesced = 0
if ARGV[2] == 'review' then
  local list = redis.call('LRANGE', KEYS[2], 0, -1)
  for i = #list, 1, -1 do
    local k = 'review'
    local ok, d = pcall(cjson.decode, list[i])
    if ok and d and d.kind then k = d.kind end
    if k == 'review' then
      if ok and d and d.action and d.action ~= 'command' and d.action ~= 'manual' and ARGV[5] then
        local base = tostring(d.installationId) .. '/' .. d.owner .. '/' .. d.repo .. '#' .. tostring(d.pr) .. '@' .. d.headSha
        redis.call('DEL', ARGV[5] .. base)
        redis.call('DEL', ARGV[5] .. base .. ':ready_for_review')
      end
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
// KEYS[1]=seen key, KEYS[2]=inflight key, KEYS[3]=pending list,
// KEYS[4]=main queue. ARGV[4] is the seen-key prefix, used to release the
// superseded automatic review's marker when coalescing.
const ENQUEUE_LUA = `
if redis.call('SET', KEYS[1], '1', 'EX', ARGV[3], 'NX') == false then
  return 'duplicate'
end
if redis.call('EXISTS', KEYS[2]) == 1 then
  local list = redis.call('LRANGE', KEYS[3], 0, -1)
  local coalesced = 0
  for i = #list, 1, -1 do
    local ok, d = pcall(cjson.decode, list[i])
    local k = 'review'
    if ok and d and d.kind then k = d.kind end
    if k == 'review' then
      if ok and d and d.action and d.action ~= 'command' and d.action ~= 'manual' and ARGV[4] then
        local base = tostring(d.installationId) .. '/' .. d.owner .. '/' .. d.repo .. '#' .. tostring(d.pr) .. '@' .. d.headSha
        redis.call('DEL', ARGV[4] .. base)
        redis.call('DEL', ARGV[4] .. base .. ':ready_for_review')
      end
      redis.call('LSET', KEYS[3], i - 1, ARGV[1])
      coalesced = 1
      break
    end
  end
  if coalesced == 1 then return 'coalesced' end
  redis.call('RPUSH', KEYS[3], ARGV[1])
  return 'coalesced'
end
redis.call('RPUSH', KEYS[4], ARGV[1])
return 'enqueued'`;

// ATOMIC dequeue claim: claim the PR's inflight lock, or — if a run for this PR
// is already in flight — coalesce into pending, as ONE step (same TOCTOU as
// enqueue: a non-atomic claim-then-stash could strand the job behind a drain
// that already ran).
// KEYS[1]=inflight key, KEYS[2]=pending list. ARGV[1]=raw job, ARGV[2]=kind,
// ARGV[3]=lock TTL seconds, ARGV[4]=immutable claim token, ARGV[5]=seen prefix.
const CLAIM_LUA = `
local ok = redis.call('SET', KEYS[1], ARGV[4] .. '\\n' .. ARGV[1], 'EX', ARGV[3], 'NX')
if ok then return 'claimed' end
${COALESCE_SNIPPET}
return 'pending'`;

// Move one job into a durable processing list atomically. If the worker dies
// before it claims the PR lock, startup recovery can find this payload and put
// it back on the main queue instead of losing it between LPOP and SET NX.
const DEQUEUE_LUA = `
local raw = redis.call('LPOP', KEYS[1])
if not raw then return false end
redis.call('RPUSH', KEYS[2], raw)
return raw`;

// Release the PR lock and move one coalesced follow-up back to the main queue
// as one Redis operation. A worker crash between a separate LPOP and RPUSH
// would otherwise lose the follow-up permanently.
const DRAIN_LUA = `
local raw = redis.call('LPOP', KEYS[1])
if not raw then return false end
redis.call('RPUSH', KEYS[2], raw)
return raw`;

function processingMetaKey(raw: string): string {
  return `${PROCESSING_META_PREFIX}${createHash('sha256').update(raw).digest('hex')}`;
}

// Compare-and-delete: DEL the key only if it still holds our exact value.
// Compare-and-EXTEND: only refresh the TTL while the lock is still OURS. An
// unconditional EXPIRE would extend a lock another worker legitimately took
// over after ours expired.
/** In-flight lease TTL. Heartbeated by renewLease() while a job runs, so this
 *  bounds how long a CRASHED worker's PR stays locked — not how long a review
 *  may take. */
const LEASE_TTL_SECONDS = 900;

const CASEXPIRE_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('EXPIRE', KEYS[1], ARGV[2])
end
return 0`;

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
const configuredMaxResume = Number(process.env.ORVEX_MAX_RESUME_AFTER_RESTART ?? 2);
const MAX_RESUME_AFTER_RESTART =
  Number.isFinite(configuredMaxResume) && configuredMaxResume >= 0
    ? Math.min(Math.floor(configuredMaxResume), 10)
    : 2;

export class RedisReviewQueue implements ReviewQueue {
  private redis: Redis;
  // Key claims by the exact dequeued job object, not by PR. If a lease expires
  // and another worker legitimately claims the same PR, the older job must not
  // accidentally use the newer token to delete or renew that lock.
  private readonly lockTokens = new WeakMap<ReviewJobPayload, string>();

  constructor(url: string) {
    this.redis = new Redis(url);
  }

  async enqueue(job: ReviewJobPayload): Promise<EnqueueResult> {
    const idKey = jobIdempotencyKey(job);
    const pk = prKey(job);

    // Already completed this exact job — or the same SHA already reviewed via
    // another automatic action (opened ↔ ready_for_review)?
    if (await this.redis.exists(`${DONE_PREFIX}${idKey}`)) {
      return { accepted: false, jobId: idKey, reason: 'duplicate' };
    }
    const bare = reviewShaIdempotencyKey(job);
    if (
      idKey !== bare &&
      (job.kind ?? 'review') === 'review' &&
      job.action !== 'command' &&
      job.action !== 'manual' &&
      (await this.redis.exists(`${DONE_PREFIX}${bare}`))
    ) {
      return { accepted: false, jobId: idKey, reason: 'duplicate' };
    }

    const raw = JSON.stringify(job);
    const kind = job.kind ?? 'review';
    // ONE atomic step: SEEN claim + inflight → coalesce to pending, else → main
    // queue. This prevents a failed enqueue from stranding the idempotency key.
    const result = await this.redis.eval(
      ENQUEUE_LUA,
      4,
      `${SEEN_PREFIX}${idKey}`,
      `${INFLIGHT_PREFIX}${pk}`,
      `${PENDING_PREFIX}${pk}`,
      QUEUE_KEY,
      raw,
      kind,
      86400,
      SEEN_PREFIX,
    );
    if (result === 'duplicate') {
      return { accepted: false, jobId: idKey, reason: 'duplicate' };
    }
    return { accepted: true, jobId: idKey, reason: result === 'coalesced' ? 'coalesced' : 'enqueued' };
  }

  async dequeue(): Promise<ReviewJobPayload | null> {
    // Return the first genuinely-runnable job, skipping (a) SHAs already reviewed
    // and (b) PRs already being processed. The queue→processing move is atomic,
    // so a crash before claim leaves a recoverable payload.
    for (let i = 0; i < 50; i++) {
      const raw = (await this.redis.eval(DEQUEUE_LUA, 2, QUEUE_KEY, PROCESSING_KEY)) as string | null | false;
      if (!raw) return null;
      let job: ReviewJobPayload;
      try {
        job = JSON.parse(raw as string) as ReviewJobPayload;
      } catch {
        await this.redis.lrem(PROCESSING_KEY, 1, raw as string);
        continue;
      }
      const pk = prKey(job);

      // Already completed this exact review (same SHA/action)? never re-review it.
      // Also skip ready_for_review when the bare SHA was already successfully reviewed.
      const doneHere = await this.redis.exists(`${DONE_PREFIX}${jobIdempotencyKey(job)}`);
      if (doneHere) {
        await this.redis.lrem(PROCESSING_KEY, 1, raw as string);
        continue;
      }
      const bare = reviewShaIdempotencyKey(job);
      const idKey = jobIdempotencyKey(job);
      if (
        idKey !== bare &&
        (job.kind ?? 'review') === 'review' &&
        job.action !== 'command' &&
        job.action !== 'manual' &&
        (await this.redis.exists(`${DONE_PREFIX}${bare}`))
      ) {
        await this.redis.lrem(PROCESSING_KEY, 1, raw as string);
        continue;
      }

      const token = randomUUID();
      const claimed = await this.redis.eval(
        CLAIM_LUA,
        2,
        `${INFLIGHT_PREFIX}${pk}`,
        `${PENDING_PREFIX}${pk}`,
        raw as string,
        job.kind ?? 'review',
        LEASE_TTL_SECONDS,
        token,
        SEEN_PREFIX,
      );
      if (claimed === 'pending') {
        await this.redis.lrem(PROCESSING_KEY, 1, raw as string);
        continue;
      }
      await this.redis.set(processingMetaKey(raw as string), String(Date.now()), 'EX', 3600);
      // Keep the raw payload in PROCESSING until markCompleted/markFailed. If
      // the worker dies after claiming, a later recovery can see the payload
      // without stealing a live lock from another worker.
      this.lockTokens.set(job, `${token}\n${raw as string}`);
      return job;
    }
    return null;
  }

  async markCompleted(job: ReviewJobPayload, opts?: MarkCompletedOptions): Promise<void> {
    if (opts?.draftSkipped) {
      await this.redis.set(`${DONE_PREFIX}${draftSkipIdempotencyKey(job)}`, '1', 'EX', 604800);
      const claim = this.lockTokens.get(job);
      if (claim) {
        await this.redis.eval(CASDEL_LUA, 1, `${INFLIGHT_PREFIX}${prKey(job)}`, claim);
      }
      await this.removeProcessing(job);
      this.lockTokens.delete(job);
      return;
    }
    const idKey = jobIdempotencyKey(job);
    await this.redis.set(`${DONE_PREFIX}${idKey}`, '1', 'EX', 604800);
    // ready_for_review success also marks bare SHA so a queued opened cannot
    // double-review the same head after ready already ran.
    const bare = reviewShaIdempotencyKey(job);
    if (idKey !== bare && (job.kind ?? 'review') === 'review') {
      await this.redis.set(`${DONE_PREFIX}${bare}`, '1', 'EX', 604800);
    }
    // Compare-and-delete: only release the lock if it is STILL ours. If this
    // review outran its TTL and another run re-claimed the PR, an unconditional
    // DEL would delete the new run's lock and let a third run start concurrently.
    const claim = this.lockTokens.get(job);
    if (claim) {
      await this.redis.eval(CASDEL_LUA, 1, `${INFLIGHT_PREFIX}${prKey(job)}`, claim);
    }
    await this.removeProcessing(job);
    this.lockTokens.delete(job);
  }

  async renewLease(job: ReviewJobPayload): Promise<void> {
    const token = this.lockTokens.get(job);
    if (!token) return;
    const renewed = await this.redis.eval(
      CASEXPIRE_LUA,
      1,
      `${INFLIGHT_PREFIX}${prKey(job)}`,
      token,
      LEASE_TTL_SECONDS,
    );
    if (Number(renewed) !== 1) {
      throw new Error(`review lease lost for ${prKey(job)}`);
    }
  }

  /**
   * Replace the dequeue-time PROCESSING JSON with the current job payload so a
   * later recoverOrphans requeue keeps mutations like `runId` (set only after
   * tryReserveReviewRun). Without this, orphan recovery loses the resume id and
   * the restarted worker reserves a second quota slot.
   */
  async persistJob(job: ReviewJobPayload): Promise<void> {
    const claim = this.lockTokens.get(job);
    if (!claim) return;
    const separator = claim.indexOf('\n');
    if (separator < 0) return;
    const token = claim.slice(0, separator);
    const oldRaw = claim.slice(separator + 1);
    const newRaw = JSON.stringify(job);
    if (newRaw === oldRaw) return;

    // Inflight lease value is `token\\nraw` (see CLAIM_LUA). renewLease /
    // markCompleted compare-and-swap against that exact string. Updating only
    // the local WeakMap (or only PROCESSING) leaves Redis on the old claim, so
    // the next heartbeat fails with "lease lost" and the worker aborts after
    // having already mutated the job (e.g. runId).
    const newClaim = `${token}\n${newRaw}`;
    const replaced = await this.redis.eval(
      `
local removed = redis.call('LREM', KEYS[1], 1, ARGV[1])
if removed == 0 then return 0 end
redis.call('RPUSH', KEYS[1], ARGV[2])
if redis.call('GET', KEYS[2]) ~= ARGV[3] then
  -- Inflight claim missing/stolen — roll PROCESSING back so we never desync
  -- lockTokens from Redis (renewLease/markCompleted CAS would fail).
  redis.call('LREM', KEYS[1], 1, ARGV[2])
  redis.call('RPUSH', KEYS[1], ARGV[1])
  return 0
end
redis.call('SET', KEYS[2], ARGV[4], 'KEEPTTL')
return 1
`,
      2,
      PROCESSING_KEY,
      `${INFLIGHT_PREFIX}${prKey(job)}`,
      oldRaw,
      newRaw,
      claim,
      newClaim,
    );
    if (Number(replaced) !== 1) return;

    const oldMeta = processingMetaKey(oldRaw);
    const newMeta = processingMetaKey(newRaw);
    const startedAt = await this.redis.get(oldMeta);
    if (startedAt !== null) {
      await this.redis.set(newMeta, startedAt, 'EX', 3600);
      await this.redis.del(oldMeta);
    } else {
      await this.redis.set(newMeta, String(Date.now()), 'EX', 3600, 'NX');
    }
    this.lockTokens.set(job, newClaim);
  }

  async markFailed(job: ReviewJobPayload, _error: string): Promise<void> {
    const idKey = jobIdempotencyKey(job);
    await this.redis.del(`${SEEN_PREFIX}${idKey}`);
    const claim = this.lockTokens.get(job);
    if (claim) {
      await this.redis.eval(CASDEL_LUA, 1, `${INFLIGHT_PREFIX}${prKey(job)}`, claim);
    }
    await this.removeProcessing(job);
    this.lockTokens.delete(job);
  }

  private async removeProcessing(job: ReviewJobPayload): Promise<void> {
    const claim = this.lockTokens.get(job);
    if (!claim) return;
    const separator = claim.indexOf('\n');
    if (separator < 0) return;
    const raw = claim.slice(separator + 1);
    await this.redis.lrem(PROCESSING_KEY, 1, raw);
    await this.redis.del(processingMetaKey(raw));
  }

  async releaseLockAndDrain(prKeyStr: string): Promise<ReviewJobPayload | null> {
    const raw = (await this.redis.eval(
      DRAIN_LUA,
      2,
      `${PENDING_PREFIX}${prKeyStr}`,
      QUEUE_KEY,
    )) as string | null | false;
    if (!raw) return null;

    return JSON.parse(raw as string) as ReviewJobPayload;
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
    // A startup hook may run while another worker is still processing a job.
    // Never delete or requeue a live inflight lock. PROCESSING is the durable
    // payload backup; once its lock disappears and its short claim grace has
    // elapsed, it is safe to return to the main queue.
    let requeued = 0;
    const processing = await this.redis.lrange(PROCESSING_KEY, 0, -1);
    for (const raw of processing) {
      let keep = false;
      try {
        const job = JSON.parse(raw) as ReviewJobPayload;
        if (await this.redis.exists(`${INFLIGHT_PREFIX}${prKey(job)}`)) {
          keep = true;
        }
        const metaKey = processingMetaKey(raw);
        const rawStartedAt = await this.redis.get(metaKey);
        const startedAt = rawStartedAt === null ? Number.NaN : Number(rawStartedAt);
        if (!keep && Number.isFinite(startedAt)) {
          keep = Date.now() - startedAt < PROCESSING_RECOVERY_GRACE_MS;
        } else if (!keep) {
          // Older workers could die between DEQUEUE_LUA and the separate
          // processing-meta SET. Treat a missing timestamp as newly observed
          // once, so recovery cannot steal that handoff immediately.
          await this.redis.set(metaKey, String(Date.now()), 'EX', 3600, 'NX');
          keep = true;
        }
        if (!keep && !(await this.redis.exists(`${DONE_PREFIX}${jobIdempotencyKey(job)}`))) {
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
            requeued++;
          }
        }
      } catch {
        /* malformed processing entry — remove it so it cannot block recovery */
      }
      if (!keep) {
        await this.redis.lrem(PROCESSING_KEY, 1, raw);
        await this.redis.del(processingMetaKey(raw));
      }
    }

    const pendingKeys = await this.scanKeys(`${PENDING_PREFIX}*`);
    for (const key of pendingKeys) {
      const pendingPrKey = key.slice(PENDING_PREFIX.length);
      if (await this.redis.exists(`${INFLIGHT_PREFIX}${pendingPrKey}`)) continue;
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

  private async scanKeys(pattern: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor = '0';
    do {
      const result = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = result[0];
      keys.push(...result[1]);
    } while (cursor !== '0');
    return keys;
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.redis.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  async depth(): Promise<import('./types.js').QueueDepth> {
    const queued = await this.redis.llen(QUEUE_KEY);
    const inFlight = await this.redis.llen(PROCESSING_KEY);
    let waitingOnPr = 0;
    const pendingKeys = await this.scanKeys(`${PENDING_PREFIX}*`);
    for (const key of pendingKeys) {
      waitingOnPr += await this.redis.llen(key);
    }
    let oldestQueuedAt: string | null = null;
    if (queued > 0) {
      const head = await this.redis.lindex(QUEUE_KEY, 0);
      if (head) {
        try {
          const job = JSON.parse(head) as { enqueuedAt?: string };
          oldestQueuedAt = job.enqueuedAt ?? null;
        } catch {
          /* ignore corrupt head */
        }
      }
    }
    return { queued, waitingOnPr, inFlight, oldestQueuedAt };
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}
