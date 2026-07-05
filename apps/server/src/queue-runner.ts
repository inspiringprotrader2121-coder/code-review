import type { ReviewQueue, ReviewJobPayload } from '@orvex-review/queue';
import { prKey } from '@orvex-review/queue';
import {
  createInstallationOctokit,
  fetchPullRequest,
  getInstallationIdForRepo,
} from '@orvex-review/github';
import { TenantService } from '@orvex-review/tenants';
import { isTransientLlmError } from '@orvex-review/review';
import { processReviewJob, loadWorkerConfig } from './worker.js';
import { processAskJob, processExplainJob, processFixJob, processResolveJob } from './autofix.js';
import { processScanJob } from './nightly.js';
import { INITIAL_BACKOFF_STATE, nextBackoffState, isPaused, type BackoffState } from './backoff.js';

const POLL_MS = 500;

/**
 * Circuit breaker: after this many CONSECUTIVE provider rate-limit/quota/network
 * failures across the worker, stop dequeuing new jobs for BACKOFF_MS instead of
 * continuing to fail job after job. See backoff.ts for the incident this fixes.
 */
const BACKOFF_THRESHOLD = Math.max(1, Number(process.env.ORVEX_BACKOFF_THRESHOLD ?? 3));
const BACKOFF_MS = Math.max(1000, Number(process.env.ORVEX_BACKOFF_MS ?? 300_000));

/**
 * How many jobs this process runs at once. Reviews are minutes-long LLM calls,
 * so without a cap the old `setInterval` fanned out one new job every 500ms with
 * NO bound — dozens of concurrent multi-minute calls would exhaust memory and
 * blow the provider's rate limit. This caps a single worker process; scale total
 * throughput horizontally by running more processes against the Redis queue.
 */
const MAX_CONCURRENT = Math.max(1, Number(process.env.ORVEX_MAX_CONCURRENT_REVIEWS ?? 4));

export function startWorkerLoop(queue: ReviewQueue): () => Promise<void> {
  let running = true;
  let active = 0;
  // Jobs currently being processed — so a graceful shutdown (deploy/restart) can
  // re-queue them instead of killing them mid-flight and losing the work.
  const inFlight = new Set<ReviewJobPayload>();
  let backoff: BackoffState = INITIAL_BACKOFF_STATE;

  const processOne = async (job: ReviewJobPayload) => {
    inFlight.add(job);
    const pk = prKey(job);
    const kind = job.kind ?? 'review';
    console.log(
      `[worker] start inst=${job.installationId} ${pk} @ ${job.headSha.slice(0, 7)} kind=${kind} action=${job.action} (active=${active}/${MAX_CONCURRENT})`,
    );

    try {
      const config = loadWorkerConfig();
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
      await queue.markCompleted(job);
      backoff = nextBackoffState(backoff, 'success', Date.now(), {
        threshold: BACKOFF_THRESHOLD,
        backoffMs: BACKOFF_MS,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[worker] failed ${pk}:`, message);
      await queue.markFailed(job, message);
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
      }
    } finally {
      inFlight.delete(job);
      const next = await queue.releaseLockAndDrain(pk);
      if (next) {
        console.log(`[worker] coalesced follow-up ${pk} @ ${next.headSha.slice(0, 7)}`);
      }
    }
  };

  // Pump: fill free concurrency slots each tick. Each job decrements `active`
  // when it settles, so at most MAX_CONCURRENT run at once and the queue keeps
  // draining as slots free up.
  const pump = async () => {
    if (!running) return;
    if (isPaused(backoff, Date.now())) return; // circuit breaker tripped — don't hammer a down/exhausted provider
    while (active < MAX_CONCURRENT) {
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

  // Graceful shutdown. Release the lock + dedup keys for every interrupted job,
  // but ONLY re-queue cheap, user-initiated command jobs (fix/ask/explain/
  // resolve/scan). REVIEW jobs are deliberately NOT re-run: re-executing an
  // interrupted deep review from scratch re-incurs its full (expensive) cost —
  // the exact thing that wasted money on a restart. The next push reviews the
  // latest code anyway, and startup's failStaleRunningRuns marks the interrupted
  // attempt 'skipped'.
  return async () => {
    running = false;
    clearInterval(interval);
    if (inFlight.size === 0) return;
    let requeued = 0;
    for (const job of inFlight) {
      try {
        await queue.markFailed(job, 'interrupted by restart');
        if ((job.kind ?? 'review') !== 'review') {
          await queue.enqueue(job);
          requeued += 1;
        }
      } catch (err) {
        console.error('[worker] shutdown handling failed for a job', err);
      }
    }
    console.log(
      `[worker] shutdown: ${inFlight.size} interrupted — ${requeued} command job(s) re-queued; reviews left for the next push (not re-run)`,
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
      installationId = await getInstallationIdForRepo(config.github, input.owner, input.repo);
      const slug = input.tenantSlug ?? input.owner.toLowerCase();
      const { installation } = await tenants.completeInstallCallback(
        installationId,
        slug,
        config.github,
      );
      tenantId = installation.tenantId;
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
