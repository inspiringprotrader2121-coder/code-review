import { FLEET_PROVIDER_BUCKETS } from '@orvex-review/config';
import type { ProviderAdmission, ReviewJobPayload, ReviewQueue } from '@orvex-review/queue';
import { prKey, providersSaturated, queueFailure } from '@orvex-review/queue';
import type { ServerConfig } from '../../bootstrap/config.js';

/** The worker ceiling is a composition policy, independent from provider lanes. */
export function resolveWorkerConcurrency(config: Pick<ServerConfig, 'worker'>): number {
  return config.worker.concurrency;
}

/** Whole-review retries are deliberately opt-in and capped to one. */
export function resolveMaxJobRetries(config: Pick<ServerConfig, 'worker'>): number {
  return config.worker.maxJobRetries;
}

export async function finalizeQueueJob(
  queue: Pick<ReviewQueue, 'markCompleted' | 'markFailed'>,
  job: ReviewJobPayload,
  opts: { draftSkipped: boolean; prClosedMidRun: boolean },
): Promise<boolean> {
  if (opts.prClosedMidRun) {
    return (await queue.markFailed(job, queueFailure('pr_closed', 'pr_closed_mid_run'))) !== false;
  }
  return (await queue.markCompleted(job, { draftSkipped: opts.draftSkipped })) !== false;
}

/** A restart cannot safely replay paid stages without durable stage checkpoints. */
export async function failInterruptedJobs(
  queue: Pick<ReviewQueue, 'markFailed'>,
  store: { interruptReviewRun(runId: string): void },
  jobs: Iterable<ReviewJobPayload>,
): Promise<number> {
  let failed = 0;
  for (const job of jobs) {
    if (job.runId) store.interruptReviewRun(job.runId);
    await queue.markFailed(job, queueFailure('worker_restart', 'interrupted by restart'));
    failed++;
  }
  return failed;
}

/** Bound shutdown while a dequeue may still be claiming a durable payload. */
export async function waitForReservedDequeues(
  getActive: () => number,
  getInFlight: () => number,
  timeoutMs = 2_000,
  pollMs = 25,
): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (getActive() > getInFlight() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.max(1, pollMs)));
  }
  return getActive() <= getInFlight();
}

/** Prefer a coalesced newer SHA when a claimed job arrives after a drain. */
export async function returnLateDequeuedJob(
  queue: Pick<ReviewQueue, 'markFailed' | 'releaseLockAndDrain' | 'enqueue'>,
  job: ReviewJobPayload,
): Promise<'newer-pending' | 'requeued'> {
  const owned =
    (await queue.markFailed(
      job,
      queueFailure('worker_stopped', 'worker stopped before review start'),
    )) !== false;
  if (!owned) throw new Error(`review lease lost before returning late dequeue for ${prKey(job)}`);
  const pending = await queue.releaseLockAndDrain(prKey(job));
  if (pending) return 'newer-pending';
  await queue.enqueue({ ...job, enqueuedAt: new Date().toISOString() });
  return 'requeued';
}

export function shouldReturnDequeuedJob(running: boolean, draining: boolean): boolean {
  return !running || draining;
}

/** True when every fleet provider lane is at its active lease ceiling. */
export async function fleetProvidersSaturated(
  admission: ProviderAdmission | null | undefined,
  providers: readonly string[] = FLEET_PROVIDER_BUCKETS,
): Promise<boolean> {
  if (!admission) return false;
  return providersSaturated(admission, providers);
}

/**
 * Return a claimed job to the ready queue without advancing its age so oldest /
 * straggler work keeps FIFO priority once provider headroom returns.
 */
export async function returnJobForProviderHeadroom(
  queue: Pick<ReviewQueue, 'markFailed' | 'releaseLockAndDrain' | 'enqueue'> & {
    returnToQueue?: ReviewQueue['returnToQueue'];
  },
  job: ReviewJobPayload,
  opts: { availableAtMs?: number } = {},
): Promise<'newer-pending' | 'requeued'> {
  if (queue.returnToQueue) {
    const result = await queue.returnToQueue(job, opts);
    if (result === false) {
      throw new Error(`review lease lost before returning headroom-deferred job for ${prKey(job)}`);
    }
    return result;
  }
  const owned =
    (await queue.markFailed(
      job,
      queueFailure('provider_transient', 'provider headroom unavailable before review start', true),
    )) !== false;
  if (!owned)
    throw new Error(`review lease lost before returning headroom-deferred job for ${prKey(job)}`);
  const pending = await queue.releaseLockAndDrain(prKey(job));
  if (pending) return 'newer-pending';
  const next: ReviewJobPayload = { ...job, enqueuedAt: job.enqueuedAt };
  if (opts.availableAtMs) next.availableAtMs = opts.availableAtMs;
  else delete next.availableAtMs;
  await queue.enqueue(next);
  return 'requeued';
}
