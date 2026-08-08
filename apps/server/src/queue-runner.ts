import { existsSync } from 'node:fs';
import type { ReviewQueue, ReviewJobPayload, QueueDepth } from '@orvex-review/queue';
import { prKey } from '@orvex-review/queue';
import {
  createInstallationOctokit,
  fetchPullRequest,
  getInstallationIdForRepo,
} from '@orvex-review/github';
import { TenantService } from '@orvex-review/tenants';
import { isTransientLlmError, killAllCodexChildren, setCodexChildListener } from '@orvex-review/review';
import { processReviewJob, loadWorkerConfig } from './worker.js';
import {
  noteActiveChildExit,
  noteActiveChildSpawn,
  runWithActiveReview,
} from './active-reviews.js';

// Attribute Codex child PIDs to the in-flight review that spawned them so the
// super-admin live monitor can show per-client RAM (not just shared Node RSS).
setCodexChildListener({
  onSpawn: noteActiveChildSpawn,
  onExit: noteActiveChildExit,
});

// Live count of in-flight jobs, exposed on /ready so deploys can WAIT FOR IDLE
// before restarting. Restarting mid-review both discards the review (now
// mitigated by resume-once) and — worse — can kill a codex process mid
// token-refresh, invalidating the OAuth session account-wide (the recurring
// "codex logged out" incidents).
let activeGauge: () => number = () => 0;
function registerActiveGauge(fn: () => number): void {
  activeGauge = fn;
}
export function getActiveJobCount(): number {
  return activeGauge();
}

let queueDepthProvider: (() => Promise<QueueDepth>) | null = null;
export async function getQueueDepth(): Promise<QueueDepth> {
  if (queueDepthProvider) return queueDepthProvider();
  return { queued: 0, waitingOnPr: 0, inFlight: getActiveJobCount(), oldestQueuedAt: null };
}

export function isDeployDraining(): boolean {
  return existsSync(process.env.ORVEX_DEPLOY_DRAIN_PATH ?? '/home/orvex/orvex-data/deploy-drain');
}
import { processAskJob, processExplainJob, processFixJob, processResolveJob } from './autofix.js';
import { processScanJob } from './nightly.js';
import { INITIAL_BACKOFF_STATE, nextBackoffState, isPaused, type BackoffState } from './backoff.js';
import { sendOperationalAlert } from './alerts.js';

const POLL_MS = 500;
const RECOVERY_MS = 30_000;

function boundedEnvInt(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : fallback;
}

/**
 * Circuit breaker: after this many CONSECUTIVE provider rate-limit/quota/network
 * failures across the worker, stop dequeuing new jobs for BACKOFF_MS instead of
 * continuing to fail job after job. See backoff.ts for the incident this fixes.
 */
const BACKOFF_THRESHOLD = boundedEnvInt('ORVEX_BACKOFF_THRESHOLD', 3, 1, 1_000);
const BACKOFF_MS = boundedEnvInt('ORVEX_BACKOFF_MS', 300_000, 1_000, 86_400_000);

/**
 * How many jobs this process runs at once. Reviews are minutes-long LLM calls,
 * so without a cap the old `setInterval` fanned out one new job every 500ms with
 * NO bound — dozens of concurrent multi-minute calls would exhaust memory and
 * blow the provider's rate limit. This caps a single worker process; scale total
 * throughput horizontally by running more processes against the Redis queue.
 */
const MAX_CONCURRENT = boundedEnvInt('ORVEX_MAX_CONCURRENT_REVIEWS', 4, 1, 100);

/** Cap used by the live resource monitor so the UI matches the worker. */
export function maxConcurrentReviews(): number {
  return MAX_CONCURRENT;
}

export function startWorkerLoop(queue: ReviewQueue): () => Promise<void> {
  let running = true;
  let active = 0;
  // Jobs currently being processed — so a graceful shutdown (deploy/restart) can
  // re-queue them instead of killing them mid-flight and losing the work.
  const inFlight = new Set<ReviewJobPayload>();
  // Include reserved dequeue slots as active. This closes the tiny handoff
  // window where a deploy could observe zero in-flight jobs while a dequeue
  // promise had already started but had not yet entered `inFlight`.
  registerActiveGauge(() => active);
  queueDepthProvider = async () => {
    if (queue.depth) return queue.depth();
    return { queued: 0, waitingOnPr: 0, inFlight: active, oldestQueuedAt: null };
  };
  let backoff: BackoffState = INITIAL_BACKOFF_STATE;

  const processOne = async (job: ReviewJobPayload) => {
    inFlight.add(job);
    const pk = prKey(job);
    const kind = job.kind ?? 'review';
    console.log(
      `[worker] start inst=${job.installationId} ${pk} @ ${job.headSha.slice(0, 7)} kind=${kind} action=${job.action} (active=${active}/${MAX_CONCURRENT})`,
    );

    // Heartbeat the in-flight lease. Without this the lease is a fixed TTL taken
    // at claim time: a review that outruns it lets another worker's SET NX
    // succeed and review the SAME PR concurrently — duplicate comments and a
    // double overage charge. Renewing at a third of the TTL tolerates two missed
    // beats. A crashed worker stops renewing, so the lock still expires.
    let leaseLost = false;
    const leaseTimer = queue.renewLease
      ? setInterval(() => {
          queue.renewLease?.(job).catch((err) => {
            const message = (err as Error).message ?? String(err);
            // Only sticky-fail on confirmed ownership loss. A transient Redis
            // blip must not discard a multi-minute review that already spent $$.
            if (/lease lost/i.test(message)) {
              leaseLost = true;
            }
            console.warn(`[worker] lease renewal failed for ${pk}:`, message);
          });
        }, boundedEnvInt('ORVEX_LEASE_RENEW_MS', 300_000, 10_000, 300_000))
      : undefined;
    if (leaseTimer) leaseTimer.unref?.();

    // Live ownership check used before GitHub writes. The sticky leaseLost flag
    // alone can lag a mid-interval takeover; await renewLease here so we never
    // publish under a stolen lease. Transient Redis errors must NOT sticky-fail
    // a review that already burned LLM spend.
    const leaseValid = async (): Promise<boolean> => {
      if (leaseLost) return false;
      if (!queue.renewLease) return true;
      try {
        await queue.renewLease(job);
        return true;
      } catch (err) {
        const message = (err as Error).message ?? String(err);
        if (/lease lost/i.test(message)) {
          leaseLost = true;
          console.warn(`[worker] lease ownership lost for ${pk}:`, message);
          return false;
        }
        console.warn(`[worker] transient lease check failed for ${pk}:`, message);
        try {
          await queue.renewLease(job);
          return true;
        } catch (err2) {
          const message2 = (err2 as Error).message ?? String(err2);
          if (/lease lost/i.test(message2)) {
            leaseLost = true;
            console.warn(`[worker] lease ownership lost on retry for ${pk}:`, message2);
            return false;
          }
          // Still transient — do not sticky-fail; caller decides.
          console.warn(`[worker] lease check still transient for ${pk}; treating as valid for completion`);
          return true;
        }
      }
    };

    // Bind this async stack to the live resource registry so checkout dirs and
    // Codex children attribute to THIS client review in the super-admin panel.
    return runWithActiveReview(job, async () => {
    try {
      const config = {
        ...loadWorkerConfig(),
        leaseValid,
        persistJob: queue.persistJob ? (j: ReviewJobPayload) => queue.persistJob!(j) : undefined,
      };
      let draftSkipped = false;
      if (kind === 'fix') {
        await processFixJob(job, config);
      } else if (kind === 'explain') {
        await processExplainJob(job, config);
      } else if (kind === 'ask') {
        await processAskJob(job, config);
      } else if (kind === 'resolve') {
        await processResolveJob(job, config);
      } else if (kind === 'scan') {
        await processScanJob(job, config);
      } else {
        const result = await processReviewJob(job, config);
        if (leaseLost || !(await leaseValid())) {
          throw new Error(`review lease lost for ${pk}; discarding this worker result`);
        }
        draftSkipped = result.skipReason === 'draft PR';
        // auto-apply mode: commit Orvex's ready fixes right after each review
        if (!result.skipReason && result.newCount > 0) {
          const settings = config.store.getPrSettings(job);
          if (settings.autoApply) {
            await queue.enqueue({
              ...job,
              kind: 'fix',
              action: 'command',
              fix: { scope: 'ready', requestedBy: undefined },
              enqueuedAt: new Date().toISOString(),
            });
            console.log(`[worker] auto-apply queued for ${pk}`);
          }
        }
      }
      // processReviewJob already published (or skipped) on success. Never
      // markFailed after that — clearing SEEN without DONE causes duplicate reviews.
      if (leaseLost) {
        console.warn(
          `[worker] lease lost after job finished for ${pk} — marking completed to avoid duplicate`,
        );
      } else if (!(await leaseValid())) {
        console.warn(
          `[worker] post-job lease check failed for ${pk} — marking completed anyway`,
        );
      }
      await queue.markCompleted(job, { draftSkipped });
      backoff = nextBackoffState(backoff, 'success', Date.now(), {
        threshold: BACKOFF_THRESHOLD,
        backoffMs: BACKOFF_MS,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[worker] failed ${pk}:`, message);
      await queue.markFailed(job, message);
      // Re-queue a TRANSIENT failure (bounded) so a rate-limit/network blip on a
      // `synchronize` doesn't leave that PR silently unreviewed — the webhook
      // already returned 200, so GitHub won't redeliver. Non-transient failures
      // (real bugs) are NOT retried; the circuit breaker still pauses the pump.
      const attempts = (job.attempts ?? 0) + 1;
      // Clamped: a garbage env (NaN) must not silently disable retries, and an
      // absurd value must not retry a poison job forever. 0..10, default 2.
      const MAX_JOB_RETRIES = (() => {
        const n = Number(process.env.ORVEX_MAX_JOB_RETRIES ?? 2);
        return Number.isFinite(n) ? Math.min(Math.max(Math.floor(n), 0), 10) : 2;
      })();
      // A user-triggered @orvex review is never silently rerun in full after a
      // provider timeout: that multiplies spend and can keep a PR busy for tens
      // of minutes. Automatic webhook jobs retain bounded transient retries.
      if (job.action !== 'command' && isTransientLlmError(message) && attempts <= MAX_JOB_RETRIES) {
        console.warn(`[worker] transient failure on ${pk} — re-queuing (attempt ${attempts}/${MAX_JOB_RETRIES})`);
        await queue.enqueue({ ...job, attempts }).catch((e) =>
          console.error(`[worker] could not re-queue ${pk}:`, (e as Error).message),
        );
      }
      const wasPaused = isPaused(backoff, Date.now());
      backoff = nextBackoffState(
        backoff,
        isTransientLlmError(message) ? 'transient_failure' : 'other_failure',
        Date.now(),
        { threshold: BACKOFF_THRESHOLD, backoffMs: BACKOFF_MS },
      );
      if (!wasPaused && isPaused(backoff, Date.now())) {
        console.warn(
          `[worker] ${backoff.consecutiveFailures} consecutive provider failures — pausing new reviews for ${Math.round(BACKOFF_MS / 1000)}s (provider looks rate-limited/out of quota)`,
        );
        void sendOperationalAlert({
          event: 'worker-provider-circuit-open',
          severity: 'critical',
          message: `${backoff.consecutiveFailures} consecutive provider failures; new reviews paused for ${Math.round(BACKOFF_MS / 1000)}s.`,
        });
      }
    } finally {
      // Stop heartbeating BEFORE releasing the lock, so a renewal can never
      // resurrect a lease the completion path just compare-and-deleted.
      if (leaseTimer) clearInterval(leaseTimer);
      inFlight.delete(job);
      const next = await queue.releaseLockAndDrain(pk);
      if (next) {
        console.log(`[worker] coalesced follow-up ${pk} @ ${next.headSha.slice(0, 7)}`);
      }
    }
    });
  };

  // Pump: fill free concurrency slots each tick. Each job decrements `active`
  // when it settles, so at most MAX_CONCURRENT run at once and the queue keeps
  // draining as slots free up.
  const pump = async () => {
    // Re-checked PER ITERATION below too: a deploy-drain flag or a tripped
    // circuit breaker appearing MID-LOOP must stop further dequeues in this
    // same tick, not just the next one.
    while (active < MAX_CONCURRENT) {
      if (!running || isDeployDraining()) return;
      if (isPaused(backoff, Date.now())) return; // circuit breaker tripped — don't hammer a down/exhausted provider
      // Reserve the slot BEFORE the async dequeue so two overlapping pump ticks
      // can't both pass the guard and exceed MAX_CONCURRENT; release it if the
      // dequeue turns up empty.
      active++;
      let job: ReviewJobPayload | null = null;
      try {
        job = await queue.dequeue();
      } catch (err) {
        active--;
        console.error('[worker] dequeue error', err);
        break;
      }
      if (!job) {
        active--;
        break;
      }
      // .catch keeps a processOne rejection (e.g. releaseLockAndDrain throwing)
      // from becoming an unhandled rejection; .finally always frees the slot.
      void processOne(job)
        .catch((err) => console.error('[worker] processOne error', err))
        .finally(() => {
          active--;
        });
    }
  };

  const interval = setInterval(() => {
    pump().catch((err) => console.error('[worker] pump error', err));
  }, POLL_MS);
  const recoveryInterval = setInterval(() => {
    queue.recoverOrphans().catch((err) => console.error('[worker] orphan recovery error', err));
  }, RECOVERY_MS);
  recoveryInterval.unref?.();

  // Graceful shutdown. Release the lock + dedup keys for every interrupted job
  // and RE-QUEUE it so it resumes after the restart — a deploy must never eat a
  // review (real incident: PR #78's near-complete review was discarded by a
  // deploy restart, leaving the PR silently unreviewed). Cost protection stays:
  // each job may be resumed at most ONCE (resumedAfterRestart flag), so a
  // crash/restart LOOP can't re-run the same expensive review forever.
  return async () => {
    running = false;
    clearInterval(interval);
    clearInterval(recoveryInterval);
    if (active === 0) return;
    // DRAIN before force-requeue: give in-flight jobs a window to FINISH
    // naturally. Killing a codex process mid token-refresh corrupts its OAuth
    // session, so exiting while codex is running is the last resort, not the
    // default. pm2's kill timeout must exceed this (set on the server).
    const drainMs = boundedEnvInt('ORVEX_SHUTDOWN_DRAIN_MS', 240_000, 1_000, 86_400_000);
    const deadline = Date.now() + drainMs;
    if (active > 0) {
      console.log(`[worker] shutdown: draining ${active} active slot(s) (up to ${Math.round(drainMs / 1000)}s)…`);
      while (active > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    if (active === 0) {
      console.log('[worker] shutdown: drained cleanly — no jobs interrupted');
      return;
    }
    // Do not return while a slot is still awaiting dequeue. A queue can claim a
    // job between the deadline and process exit; wait until each active slot is
    // represented in `inFlight`, then requeue that complete snapshot below.
    if (active > inFlight.size) {
      console.error('[worker] shutdown: waiting for pending dequeue slot(s) to resolve before exit');
      while (active > inFlight.size) {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    if (inFlight.size === 0) {
      return;
    }
    // Kill any in-flight codex agent BEFORE requeueing. codex children are
    // spawned `detached` (own process group, so a timeout can kill their
    // grandchildren), which also means they OUTLIVE this worker — every deploy
    // would otherwise orphan an unsandboxed agent still running against a PR
    // checkout, accumulating one per deploy with no one left to clean up its
    // temp dirs.
    try {
      const killed = killAllCodexChildren();
      if (killed > 0) console.log(`[worker] shutdown: killed ${killed} in-flight codex process group(s)`);
    } catch (err) {
      console.warn('[worker] shutdown: codex kill failed:', (err as Error).message);
    }
    let requeued = 0;
    let dropped = 0;
    // Mark reserved runs interrupted BEFORE requeue so resumeReviewRun can reopen
    // the same row after restart (status must be skipped/interrupted, not running).
    const store = loadWorkerConfig().store;
    for (const job of inFlight) {
      try {
        if (job.runId) {
          store.interruptReviewRun(job.runId);
        }
        await queue.markFailed(job, 'interrupted by restart');
        if (!job.resumedAfterRestart) {
          await queue.enqueue({ ...job, resumedAfterRestart: true, enqueuedAt: new Date().toISOString() });
          requeued += 1;
        } else {
          dropped += 1; // already resumed once — don't loop
        }
      } catch (err) {
        console.error('[worker] shutdown handling failed for a job', err);
      }
    }
    console.log(
      `[worker] shutdown: ${inFlight.size} interrupted — ${requeued} re-queued to resume after restart` +
        (dropped > 0 ? `, ${dropped} dropped (already resumed once)` : ''),
    );
  };
}

export async function enqueueManualReview(
  queue: ReviewQueue,
  input: {
    owner: string;
    repo: string;
    pr: number;
    headSha?: string;
    installationId?: number;
    tenantSlug?: string;
  },
): Promise<ReviewJobPayload> {
  const config = loadWorkerConfig();
  const tenants = new TenantService(config.store);

  let installationId = input.installationId;
  let tenantId: string;

  if (installationId) {
    const inst = tenants.resolveInstallation(installationId);
    if (!inst) throw new Error(`Unknown installation_id ${installationId}`);
    tenantId = inst.tenantId;
  } else {
    const existing = config.store.findInstallationForRepo(input.owner, input.repo);
    if (existing) {
      installationId = existing.installationId;
      tenantId = existing.tenantId;
    } else {
      // Never bind an unbound GitHub install from POST /review — that path is
      // authenticated with REVIEW_API_SECRET and previously accepted a caller-
      // controlled tenantSlug (trustedServerBinding), which could steal billing
      // attribution. Resolve an existing DB row only; require the signed browser
      // connect flow to create the binding.
      const installationIdFromGithub = await getInstallationIdForRepo(
        config.github,
        input.owner,
        input.repo,
      );
      const bound = config.store.getInstallation(installationIdFromGithub);
      if (!bound) {
        throw new Error(
          `Installation ${installationIdFromGithub} for ${input.owner}/${input.repo} is not bound to a workspace — complete the GitHub App connect flow first`,
        );
      }
      installationId = bound.installationId;
      tenantId = bound.tenantId;
    }
  }

  const octokit = createInstallationOctokit(config.github, installationId);
  const pr = await fetchPullRequest(octokit, {
    owner: input.owner,
    repo: input.repo,
    number: input.pr,
  });

  const job: ReviewJobPayload = {
    installationId,
    tenantId,
    owner: input.owner,
    repo: input.repo,
    pr: input.pr,
    headSha: input.headSha ?? pr.headSha,
    action: 'manual',
    enqueuedAt: new Date().toISOString(),
  };

  await queue.enqueue(job);
  return job;
}
