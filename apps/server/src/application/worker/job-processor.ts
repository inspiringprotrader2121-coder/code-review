import type { ReviewJobPayload, ReviewQueue } from '@orvex-review/queue';
import { prKey, providerAdmissionFor, queueFailure } from '@orvex-review/queue';
import { isTransientLlmError } from '@orvex-review/review';
import {
  processAskJob,
  processExplainJob,
  processFixJob,
  processResolveJob,
} from '../../autofix.js';
import { processScanJob } from '../../nightly.js';
import { processReviewJob, type ProcessResult } from '../../pipeline.js';
import type { ServerConfig } from '../../bootstrap/config.js';
import type { WorkerConfig } from '../../review/worker-types.js';
import { runWithActiveReview } from '../../active-reviews.js';
import { sendOperationalAlert } from '../../alerts.js';
import { bindWorkerRuntime } from './runtime.js';
import { startLeaseHeartbeat } from './lease-heartbeat.js';
import { finalizeQueueJob, resolveMaxJobRetries } from './queue-policy.js';
import { alertQueueOperationalEvents } from './queue-alerts.js';

export interface JobProcessorDependencies {
  queue: ReviewQueue;
  runtime: ServerConfig;
  loadConfig: () => WorkerConfig;
  processReview?: typeof processReviewJob;
  onSettled(job: ReviewJobPayload): void;
  active: () => number;
  capacity: number;
  alert?: typeof sendOperationalAlert;
  log?: Pick<Console, 'log' | 'warn' | 'error'>;
}

function failureCode(
  message: string,
  leaseValid: boolean,
): 'lease_lost' | 'cancelled' | 'provider_transient' | 'execution_failed' {
  if (!leaseValid) return 'lease_lost';
  if (/cancel|worker_shutdown/i.test(message)) return 'cancelled';
  return isTransientLlmError(message) ? 'provider_transient' : 'execution_failed';
}

/**
 * One claimed job. It owns lease renewal and CAS-aware completion; provider
 * admission remains inside the review execution layer so an unrelated Luna
 * call cannot serialize all queue slots.
 */
export async function processWorkerJob(
  job: ReviewJobPayload,
  input: JobProcessorDependencies,
): Promise<void> {
  const log = input.log ?? console;
  const alert = input.alert ?? sendOperationalAlert;
  const queue = input.queue;
  const key = prKey(job);
  const kind = job.kind ?? 'review';
  let finalizedOwned = false;
  let leaseOwnershipValid = true;

  log.log(
    `[worker] start inst=${job.installationId} ${key} @ ${job.headSha.slice(0, 7)} kind=${kind} action=${job.action} (active=${input.active()}/${input.capacity})`,
  );
  const heartbeat = startLeaseHeartbeat({
    queue,
    job,
    renewMs: input.runtime.worker.leaseRenewMs,
    log,
  });

  await runWithActiveReview(job, async () => {
    try {
      if (!(await queue.markRunning(job))) {
        leaseOwnershipValid = false;
        throw new Error(`review lease lost before execution for ${key}`);
      }
      const config: WorkerConfig = {
        ...bindWorkerRuntime(input.loadConfig(), input.runtime),
        providerAdmission: providerAdmissionFor(queue) ?? undefined,
        leaseValid: async () => {
          const valid = await heartbeat.leaseValid();
          if (!valid) leaseOwnershipValid = false;
          return valid;
        },
        activeReviewCount: async () => {
          const depth = await queue.depth?.();
          return depth?.inFlight ?? input.active();
        },
        persistJob: queue.persistJob ? (persisted) => queue.persistJob!(persisted) : undefined,
      };
      const result = await dispatchWorkerJob(job, config, input.runtime, input.processReview);
      const draftSkipped = result?.skipReason === 'draft PR';
      const prClosedMidRun = result?.skipReason === 'pr_closed_mid_run';
      await enqueueAutoApply(job, config, queue, result, log);

      // Completion ownership is token-CAS checked by the backend. A late
      // transient renewal error must not convert a persisted review into a
      // failed/dedup-cleared one, which would spend again on the same SHA.
      if (!(await heartbeat.leaseValid())) {
        leaseOwnershipValid = false;
        log.warn(`[worker] post-job lease check failed for ${key}; marking completed anyway`);
      }
      finalizedOwned = await finalizeQueueJob(queue, job, { draftSkipped, prClosedMidRun });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error(`[worker] failed ${key}:`, message);
      const transient = isTransientLlmError(message);
      const code = failureCode(message, leaseOwnershipValid);
      const nextAttempt = (job.attempts ?? 0) + 1;
      const willRetry =
        job.action !== 'command' && transient && nextAttempt <= resolveMaxJobRetries(input.runtime);
      finalizedOwned =
        (await queue.markFailed(job, queueFailure(code, message, willRetry))) !== false;
      if (finalizedOwned) {
        await alertQueueOperationalEvents(queue, input.runtime.alerts.webhookUrl, alert);
        await requeueTransientFailure(
          job,
          willRetry,
          nextAttempt,
          input.runtime,
          queue,
          alert,
          log,
        );
      }
    } finally {
      // Stop renewal before release so no timer can revive a completed CAS
      // claim. Drain only when this worker actually completed/failed its token.
      heartbeat.stop();
      input.onSettled(job);
      if (finalizedOwned) {
        const next = await queue.releaseLockAndDrain(key);
        if (next) log.log(`[worker] coalesced follow-up ${key} @ ${next.headSha.slice(0, 7)}`);
      }
    }
  });
}

async function dispatchWorkerJob(
  job: ReviewJobPayload,
  config: WorkerConfig,
  runtime: ServerConfig,
  reviewJob: typeof processReviewJob | undefined,
): Promise<ProcessResult | undefined> {
  switch (job.kind ?? 'review') {
    case 'fix':
      await processFixJob(job, config, runtime);
      return undefined;
    case 'explain':
      await processExplainJob(job, config, runtime);
      return undefined;
    case 'ask':
      await processAskJob(job, config, runtime);
      return undefined;
    case 'resolve':
      await processResolveJob(job, config, runtime);
      return undefined;
    case 'scan':
      await processScanJob(job, config, runtime);
      return undefined;
    default:
      return (reviewJob ?? processReviewJob)(job, config);
  }
}

async function enqueueAutoApply(
  job: ReviewJobPayload,
  config: WorkerConfig,
  queue: Pick<ReviewQueue, 'enqueue'>,
  result: ProcessResult | undefined,
  log: Pick<Console, 'log'>,
): Promise<void> {
  if (!result || result.skipReason || result.newCount <= 0) return;
  if (!config.store.getPrSettings(job).autoApply) return;
  await queue.enqueue({
    ...job,
    kind: 'fix',
    action: 'command',
    fix: { scope: 'ready', requestedBy: undefined },
    enqueuedAt: new Date().toISOString(),
  });
  log.log(`[worker] auto-apply queued for ${prKey(job)}`);
}

async function requeueTransientFailure(
  job: ReviewJobPayload,
  willRetry: boolean,
  attempts: number,
  runtime: ServerConfig,
  queue: Pick<ReviewQueue, 'enqueue'>,
  alert: typeof sendOperationalAlert,
  log: Pick<Console, 'warn' | 'error'>,
): Promise<void> {
  if (!willRetry) return;
  const key = prKey(job);
  log.warn(
    `[worker] transient failure on ${key}; re-queuing (attempt ${attempts}/${resolveMaxJobRetries(runtime)})`,
  );
  try {
    const requeued = await queue.enqueue({ ...job, attempts });
    if (!requeued.accepted)
      throw new Error(`queue refused retry as ${requeued.reason ?? 'unknown'}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error(`[worker] could not re-queue ${key}:`, message);
    void alert(
      {
        event: 'review-requeue-failed',
        severity: 'critical',
        message: `Failed to requeue ${key} after transient provider failure: ${message}`,
      },
      runtime.alerts.webhookUrl,
    );
  }
}
