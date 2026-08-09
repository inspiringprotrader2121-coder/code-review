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
const PROVIDER_LEASE_PREFIX = 'orvex-review:provider-leases:';
const PROVIDER_COOLDOWN_PREFIX = 'orvex-review:provider-cooldown:';
// Recovery runs periodically while workers are active. A longer grace covers
// the dequeue→claim handoff and a brief Redis/CPU stall without requeueing a
// payload that its original worker is still about to claim.
const PROCESSING_RECOVERY_GRACE_MS = 30_000;
const PROVIDER_LEASE_TTL_MS = 960_000;

const ACQUIRE_PROVIDER_LEASE_LUA = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[2]) then return false end
redis.call('ZADD', KEYS[1], tonumber(ARGV[1]) + tonumber(ARGV[3]), ARGV[4])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[3]) + 60000)
return ARGV[4]`;

const SET_PROVIDER_COOLDOWN_LUA = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local requested = tonumber(ARGV[1])
if requested > current then
  redis.call('SET', KEYS[1], requested)
  redis.call('PEXPIREAT', KEYS[1], requested)
  return requested
end
return current`;

const RECOVER_PROCESSING_LUA = `
local cur = redis.call('GET', KEYS[3])
if cur then
  -- Tokenized processing entries distinguish an obsolete worker from a newer
  -- owner of byte-identical job JSON. Legacy raw-only entries remain live while
  -- any lock exists and are recovered after that lock disappears.
  if ARGV[5] == '' then return 'live' end
  local sep = string.find(cur, '\\n', 1, true)
  local curToken = sep and string.sub(cur, 1, sep - 1) or cur
  if curToken == ARGV[5] then return 'live' end
  local removed = redis.call('LREM', KEYS[1], 1, ARGV[1])
  if removed == 0 then return 'claimed-by-peer' end
  redis.call('DEL', KEYS[2])
  return 'superseded'
end
local started = tonumber(redis.call('GET', KEYS[2]) or '')
if not started then
  redis.call('SET', KEYS[2], ARGV[2], 'EX', 3600, 'NX')
  return 'grace'
end
if tonumber(ARGV[2]) - started < tonumber(ARGV[3]) then return 'grace' end
local removed = redis.call('LREM', KEYS[1], 1, ARGV[1])
if removed == 0 then return 'claimed-by-peer' end
redis.call('DEL', KEYS[2])
if redis.call('EXISTS', KEYS[4]) == 1 or redis.call('EXISTS', KEYS[5]) == 1 then
  return 'done'
end
local resumes = redis.call('INCR', KEYS[6])
redis.call('EXPIRE', KEYS[6], 86400)
if resumes > tonumber(ARGV[4]) then return 'dropped:' .. tostring(resumes) end
redis.call('DEL', KEYS[7])
redis.call('RPUSH', KEYS[8], ARGV[6])
return 'requeued'`;

const RECOVER_PENDING_LUA = `
if redis.call('EXISTS', KEYS[2]) == 1 then return false end
local raw = redis.call('LINDEX', KEYS[1], 0)
if not raw then return false end
if raw ~= ARGV[1] then return 'retry' end
redis.call('LPOP', KEYS[1])
redis.call('DEL', KEYS[3])
redis.call('RPUSH', KEYS[4], raw)
return raw`;

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

// Move one job into a durable processing list atomically. Prefixing the raw job
// with the immutable claim token lets finalization/recovery distinguish two
// workers that handled byte-identical payloads at different times.
const DEQUEUE_LUA = `
local raw = redis.call('LPOP', KEYS[1])
if not raw then return false end
redis.call('RPUSH', KEYS[2], ARGV[1] .. '\\n' .. raw)
return raw`;

// Release the PR lock and move one coalesced follow-up back to the main queue
// as one Redis operation. A worker crash between a separate LPOP and RPUSH
// would otherwise lose the follow-up permanently.
const DRAIN_LUA = `
local raw = redis.call('LPOP', KEYS[1])
if not raw then return false end
redis.call('RPUSH', KEYS[2], raw)
return raw`;

function processingMetaKey(entry: string): string {
  return `${PROCESSING_META_PREFIX}${createHash('sha256').update(entry).digest('hex')}`;
}

function parseProcessingEntry(entry: string): { token: string; raw: string } {
  const separator = entry.indexOf('\n');
  if (separator < 0) return { token: '', raw: entry };
  return {
    token: entry.slice(0, separator),
    raw: entry.slice(separator + 1),
  };
}

// Compare-and-delete / compare-and-EXTEND against the immutable claim TOKEN
// (prefix before the first newline). The inflight value is `token\\nrawJob`, and
// persistJob rewrites `rawJob` after reservation — comparing the FULL value
// made every renewLease fail after the first persist, so reviews burned LLM
// spend then died at publication with "lease lost".
/** In-flight lease TTL. Heartbeated by renewLease() while a job runs, so this
 *  bounds how long a CRASHED worker's PR stays locked — not how long a review
 *  may take. */
const LEASE_TTL_SECONDS = 900;

const CASEXPIRE_LUA = `
local cur = redis.call('GET', KEYS[1])
if not cur then return 0 end
local sep = string.find(cur, '\\n', 1, true)
local curToken = sep and string.sub(cur, 1, sep - 1) or cur
if curToken == ARGV[1] then
  return redis.call('EXPIRE', KEYS[1], ARGV[2])
end
return 0`;

// Finalization is one token-owned operation. Successful DONE markers are written
// only after ownership is proven, in the same Lua transaction as claim release.
// A stale worker can therefore neither finalize nor poison deduplication.
// KEYS: inflight, processing, metadata, seen, followed by zero or more DONE keys.
// ARGV: token, tokenized processing entry, delete-seen flag, DONE ttl seconds.
const FINALIZE_CLAIM_LUA = `
local cur = redis.call('GET', KEYS[1])
local curToken = nil
if cur then
  local sep = string.find(cur, '\\n', 1, true)
  curToken = sep and string.sub(cur, 1, sep - 1) or cur
end
if not curToken or curToken ~= ARGV[1] then
  -- This worker no longer owns the PR. Retire only its exact durable payload so
  -- orphan recovery cannot resurrect an obsolete SHA after the newer owner
  -- finishes. The current owner's differently serialized payload is untouched.
  redis.call('LREM', KEYS[2], 1, ARGV[2])
  redis.call('DEL', KEYS[3])
  return 0
end
for i = 5, #KEYS do
  redis.call('SET', KEYS[i], '1', 'EX', ARGV[4])
end
redis.call('DEL', KEYS[1])
redis.call('LREM', KEYS[2], 1, ARGV[2])
redis.call('DEL', KEYS[3])
if ARGV[3] == '1' then redis.call('DEL', KEYS[4]) end
return 1`;

/** Inflight lock values are `token\\nraw`. Ownership CAS uses the token only. */
function claimToken(claim: string): string {
  const sep = claim.indexOf('\n');
  return sep >= 0 ? claim.slice(0, sep) : claim;
}
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

  private providerKey(prefix: string, provider: string): string {
    const safe = provider.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    return `${prefix}${safe || 'unknown'}`;
  }

  async acquireProviderLease(provider: string, limit: number, signal?: AbortSignal): Promise<string> {
    const token = randomUUID();
    // Queue behind the distributed provider limit by default. A 30-second wait
    // cap made healthy workers fail whenever the current max-reasoning call ran
    // longer than 30 seconds. Set a positive value only for an operator-owned
    // bound; zero/unset waits until a slot is available or the review cancels.
    const configuredWait = Number(process.env.ORVEX_PROVIDER_LEASE_WAIT_MS ?? 0);
    const maxWaitMs = Number.isFinite(configuredWait) && configuredWait > 0
      ? Math.min(3_600_000, Math.max(1_000, Math.floor(configuredWait)))
      : undefined;
    const deadline = maxWaitMs === undefined ? undefined : Date.now() + maxWaitMs;
    const key = this.providerKey(PROVIDER_LEASE_PREFIX, provider);
    for (;;) {
      if (signal?.aborted) throw new Error('review cancelled while waiting for provider lease');
      const acquired = await this.redis.eval(
        ACQUIRE_PROVIDER_LEASE_LUA,
        1,
        key,
        Date.now(),
        Math.max(1, Math.floor(limit)),
        PROVIDER_LEASE_TTL_MS,
        token,
      );
      if (acquired === token) return token;
      if (deadline !== undefined && Date.now() >= deadline) {
        throw new Error(`429 provider ${provider} distributed concurrency saturated; retry-after: 1`);
      }
      await new Promise<void>((resolve, reject) => {
        const finish = () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        };
        const timer = setTimeout(finish, 100 + Math.floor(Math.random() * 150));
        const onAbort = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          reject(new Error('review cancelled while waiting for provider lease'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
        else timer.unref?.();
      });
    }
  }

  async releaseProviderLease(provider: string, token: string): Promise<void> {
    await this.redis.zrem(this.providerKey(PROVIDER_LEASE_PREFIX, provider), token);
  }

  async getProviderCooldownMs(provider: string): Promise<number> {
    const raw = await this.redis.get(this.providerKey(PROVIDER_COOLDOWN_PREFIX, provider));
    const until = Number(raw);
    return Number.isFinite(until) ? Math.max(0, until - Date.now()) : 0;
  }

  async setProviderCooldown(provider: string, durationMs: number): Promise<void> {
    const until = Date.now() + Math.min(300_000, Math.max(250, Math.floor(durationMs)));
    await this.redis.eval(
      SET_PROVIDER_COOLDOWN_LUA,
      1,
      this.providerKey(PROVIDER_COOLDOWN_PREFIX, provider),
      until,
    );
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
      const token = randomUUID();
      const raw = (await this.redis.eval(
        DEQUEUE_LUA,
        2,
        QUEUE_KEY,
        PROCESSING_KEY,
        token,
      )) as string | null | false;
      if (!raw) return null;
      const processingEntry = `${token}\n${raw as string}`;
      let job: ReviewJobPayload;
      try {
        job = JSON.parse(raw as string) as ReviewJobPayload;
      } catch {
        await this.redis.lrem(PROCESSING_KEY, 1, processingEntry);
        continue;
      }
      const pk = prKey(job);

      // Already completed this exact review (same SHA/action)? never re-review it.
      // Also skip ready_for_review when the bare SHA was already successfully reviewed.
      const doneHere = await this.redis.exists(`${DONE_PREFIX}${jobIdempotencyKey(job)}`);
      if (doneHere) {
        await this.redis.lrem(PROCESSING_KEY, 1, processingEntry);
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
        await this.redis.lrem(PROCESSING_KEY, 1, processingEntry);
        continue;
      }

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
        await this.redis.lrem(PROCESSING_KEY, 1, processingEntry);
        continue;
      }
      await this.redis.set(processingMetaKey(processingEntry), String(Date.now()), 'EX', 3600);
      // Keep the tokenized payload in PROCESSING until finalization. Recovery
      // can identify this exact claim without touching a newer owner.
      this.lockTokens.set(job, processingEntry);
      return job;
    }
    return null;
  }

  async markCompleted(job: ReviewJobPayload, opts?: MarkCompletedOptions): Promise<void> {
    let doneKeys: string[];
    if (opts?.draftSkipped) {
      doneKeys = [`${DONE_PREFIX}${draftSkipIdempotencyKey(job)}`];
    } else {
      const idKey = jobIdempotencyKey(job);
      doneKeys = [`${DONE_PREFIX}${idKey}`];
      // ready_for_review/reopened success also marks bare SHA so another
      // automatic event cannot review the same head twice.
      const bare = reviewShaIdempotencyKey(job);
      if (idKey !== bare && (job.kind ?? 'review') === 'review') {
        doneKeys.push(`${DONE_PREFIX}${bare}`);
      }
    }
    if (!(await this.finalizeOwnedClaim(job, false, doneKeys))) {
      throw new Error(`review lease lost before completion for ${prKey(job)}`);
    }
  }

  async renewLease(job: ReviewJobPayload): Promise<void> {
    const claim = this.lockTokens.get(job);
    if (!claim) throw new Error(`review lease lost for ${prKey(job)} (claim token missing)`);
    const renewed = await this.redis.eval(
      CASEXPIRE_LUA,
      1,
      `${INFLIGHT_PREFIX}${prKey(job)}`,
      claimToken(claim),
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

    const lockKey = `${INFLIGHT_PREFIX}${prKey(job)}`;
    const newClaim = `${token}\n${newRaw}`;
    const replaced = await this.redis.eval(
      `
local cur = redis.call('GET', KEYS[2])
if not cur then return 0 end
local sep = string.find(cur, '\\n', 1, true)
local curToken = sep and string.sub(cur, 1, sep - 1) or cur
if curToken ~= ARGV[1] then return 0 end
local removed = redis.call('LREM', KEYS[1], 1, ARGV[2])
if removed == 0 then return 0 end
redis.call('RPUSH', KEYS[1], ARGV[3])
local ttl = redis.call('TTL', KEYS[2])
if ttl ~= false and ttl > 0 then
  redis.call('SET', KEYS[2], ARGV[4], 'EX', ttl)
else
  redis.call('SET', KEYS[2], ARGV[4], 'EX', tonumber(ARGV[5]))
end
return 1
`,
      2,
      PROCESSING_KEY,
      lockKey,
      token,
      claim,
      newClaim,
      newClaim,
      LEASE_TTL_SECONDS,
    );
    if (Number(replaced) !== 1) return;

    const oldMeta = processingMetaKey(claim);
    const newMeta = processingMetaKey(newClaim);
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
    await this.finalizeOwnedClaim(job, true);
  }

  private async finalizeOwnedClaim(
    job: ReviewJobPayload,
    deleteSeen: boolean,
    doneKeys: string[] = [],
  ): Promise<boolean> {
    const claim = this.lockTokens.get(job);
    if (!claim) return false;
    const separator = claim.indexOf('\n');
    if (separator < 0) return false;
    const token = claim.slice(0, separator);
    const finalized = await this.redis.eval(
      FINALIZE_CLAIM_LUA,
      4 + doneKeys.length,
      `${INFLIGHT_PREFIX}${prKey(job)}`,
      PROCESSING_KEY,
      processingMetaKey(claim),
      `${SEEN_PREFIX}${jobIdempotencyKey(job)}`,
      ...doneKeys,
      token,
      claim,
      deleteSeen ? '1' : '0',
      604800,
    );
    this.lockTokens.delete(job);
    return Number(finalized) === 1;
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
    for (const entry of processing) {
      const { token, raw } = parseProcessingEntry(entry);
      let job: ReviewJobPayload;
      try {
        job = JSON.parse(raw) as ReviewJobPayload;
      } catch {
        // Malformed processing entry has no valid ownership identity and cannot
        // be recovered. Removal is atomic enough because no worker can parse it.
        await this.redis.lrem(PROCESSING_KEY, 1, entry);
        await this.redis.del(processingMetaKey(entry));
        continue;
      }
      const idKey = jobIdempotencyKey(job);
      const bare = reviewShaIdempotencyKey(job);
      const automatic = (job.kind ?? 'review') === 'review'
        && job.action !== 'command'
        && job.action !== 'manual';
      const recovered = String(await this.redis.eval(
        RECOVER_PROCESSING_LUA,
        8,
        PROCESSING_KEY,
        processingMetaKey(entry),
        `${INFLIGHT_PREFIX}${prKey(job)}`,
        `${DONE_PREFIX}${idKey}`,
        `${DONE_PREFIX}${automatic ? bare : idKey}`,
        `${RESUMED_PREFIX}${idKey}`,
        `${SEEN_PREFIX}${idKey}`,
        QUEUE_KEY,
        entry,
        Date.now(),
        PROCESSING_RECOVERY_GRACE_MS,
        MAX_RESUME_AFTER_RESTART,
        token,
        raw,
      ));
      if (recovered === 'requeued') requeued++;
      if (recovered.startsWith('dropped:')) {
        console.error(
          `[queue] DROPPING job ${idKey} — resumed ${recovered.slice('dropped:'.length)}x after restarts ` +
            `(cap ${MAX_RESUME_AFTER_RESTART}); it appears to crash the worker. Investigate manually.`,
        );
      }
    }

    const pendingKeys = await this.scanKeys(`${PENDING_PREFIX}*`);
    for (const key of pendingKeys) {
      const pendingPrKey = key.slice(PENDING_PREFIX.length);
      if (await this.redis.exists(`${INFLIGHT_PREFIX}${pendingPrKey}`)) continue;
      for (;;) {
        const raw = await this.redis.lindex(key, 0);
        if (!raw) break;
        let job: ReviewJobPayload;
        try {
          job = JSON.parse(raw) as ReviewJobPayload;
        } catch {
          // Remove malformed queue input; it cannot be executed safely.
          await this.redis.lrem(key, 1, raw);
          continue;
        }
        const moved = await this.redis.eval(
          RECOVER_PENDING_LUA,
          4,
          key,
          `${INFLIGHT_PREFIX}${pendingPrKey}`,
          `${SEEN_PREFIX}${jobIdempotencyKey(job)}`,
          QUEUE_KEY,
          raw,
        );
        if (!moved) break;
        if (moved === 'retry') continue;
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
