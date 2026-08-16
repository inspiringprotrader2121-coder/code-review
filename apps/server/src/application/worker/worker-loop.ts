import type { ReviewJobPayload, ReviewQueue } from '@orvex-review/queue';
import { providerAdmissionFor } from '@orvex-review/queue';
import { killAllCodexChildren } from '@orvex-review/review';
import { cancelAllActiveReviews } from '../../active-reviews.js';
import { loadWorkerConfig } from '../../pipeline.js';
import { assessHostAdmission } from './host-admission.js';
import {
  failInterruptedJobs,
  fleetProvidersSaturated,
  returnLateDequeuedJob,
  resolveWorkerConcurrency,
  resolveWorkerPollerCount,
  shouldReturnDequeuedJob,
  waitForReservedDequeues,
} from './queue-policy.js';
import { startPeriodicRecovery } from './recovery-service.js';
import { registerWorkerMetrics, isDeployDraining } from './runtime.js';
import { processWorkerJob } from './job-processor.js';
import type { WorkerLoopDependencies } from './contracts.js';

const DEFAULT_POLL_MS = 500;
const HOST_ADMISSION_LOG_EVERY_MS = 30_000;

/**
 * Starts one dequeue poller. Capacity is the max in-flight reviews, not the
 * number of loops — one poller can fill all slots, while extra idle pollers
 * multiply Redis work across the fleet.
 */
export function startBoundedWorkerLoop(
  queue: ReviewQueue,
  dependencies: WorkerLoopDependencies,
): () => Promise<void> {
  let running = true;
  let active = 0;
  let lastHostAdmissionLogMs = 0;
  const capacity = dependencies.maxConcurrent ?? resolveWorkerConcurrency(dependencies.config);
  const pollMs = dependencies.pollMs ?? DEFAULT_POLL_MS;
  const draining = dependencies.isDraining ?? (() => isDeployDraining(dependencies.config));
  const canAdmitHost =
    dependencies.canAdmitHost ??
    (() => {
      const decision = assessHostAdmission(dependencies.config.hostAdmission);
      if (!decision.ok) {
        const now = Date.now();
        if (now - lastHostAdmissionLogMs >= HOST_ADMISSION_LOG_EVERY_MS) {
          lastHostAdmissionLogMs = now;
          console.warn(`[worker] host admission deferred dequeue: ${decision.reason}`);
        }
      }
      return decision.ok;
    });
  const loadConfig = dependencies.loadConfig ?? (() => loadWorkerConfig(dependencies.db));
  const inFlight = new Set<ReviewJobPayload>();
  const waitForPoll = () =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, pollMs);
      timer.unref?.();
    });
  const yieldForAdmission = () => new Promise<void>((resolve) => setImmediate(resolve));

  registerWorkerMetrics({
    active: () => active,
    capacity,
    depth: async () =>
      queue.depth?.() ?? {
        queued: 0,
        waitingOnPr: 0,
        inFlight: active,
        oldestQueuedAt: null,
      },
  });

  const processOne = async (job: ReviewJobPayload): Promise<void> => {
    inFlight.add(job);
    await processWorkerJob(job, {
      queue,
      runtime: dependencies.config,
      loadConfig,
      processReview: dependencies.processReview,
      active: () => active,
      capacity,
      onSettled: (settled) => inFlight.delete(settled),
    });
  };

  const workerLoop = async (workerIndex: number): Promise<void> => {
    while (running) {
      if (draining() || !canAdmitHost() || active >= capacity) {
        await waitForPoll();
        continue;
      }
      // Avoid filling every worker slot with long provider-lease waiters when the
      // fleet already has no free Luna/DeepSeek/MiniMax capacity.
      if (await fleetProvidersSaturated(providerAdmissionFor(queue))) {
        await waitForPoll();
        continue;
      }

      let claimed = 0;
      while (running && active < capacity && !draining() && canAdmitHost()) {
        if (await fleetProvidersSaturated(providerAdmissionFor(queue))) break;
        active++;
        let job: ReviewJobPayload | null = null;
        try {
          job = await queue.dequeue();
        } catch (error) {
          console.error(`[worker:${workerIndex}] dequeue error`, error);
        }
        if (!job) {
          active--;
          break;
        }
        if (shouldReturnDequeuedJob(running, draining())) {
          try {
            await returnLateDequeuedJob(queue, job);
          } catch (error) {
            console.error(`[worker:${workerIndex}] could not return late-dequeued job`, error);
          } finally {
            active--;
          }
          continue;
        }
        claimed += 1;
        void processOne(job)
          .catch((error) => {
            console.error(`[worker:${workerIndex}] processOne error`, error);
          })
          .finally(() => {
            active--;
          });
        // Give the newly launched job an event-loop turn to reserve provider
        // capacity or start its sandbox before the next host/provider admission
        // decision. Without this yield, a high nominal ceiling can synchronously
        // pre-claim thousands of jobs before RAM, disk, or Redis leases reflect
        // the work that has just started.
        await yieldForAdmission();
      }
      if (claimed === 0) await waitForPoll();
    }
  };

  const pollers = resolveWorkerPollerCount(capacity);
  console.log(`[worker] dequeue pollers=${pollers} review_capacity=${capacity}`);
  void Promise.all(Array.from({ length: pollers }, (_, index) => workerLoop(index + 1))).catch(
    (error) => console.error('[worker] worker loop error', error),
  );
  const stopRecovery =
    dependencies.enablePeriodicRecovery === false
      ? () => {}
      : startPeriodicRecovery({
          queue,
          config: dependencies.config,
          intervalMs: dependencies.recoveryMs,
        });

  return async (): Promise<void> => {
    running = false;
    stopRecovery();
    if (active === 0) return;

    const drainMs = dependencies.shutdownDrainMs ?? dependencies.config.worker.shutdownDrainMs;
    const deadline = Date.now() + drainMs;
    console.log(
      `[worker] shutdown: draining ${active} active slot(s) (up to ${Math.round(drainMs / 1_000)}s)`,
    );
    while (active > 0 && Date.now() < deadline) {
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(2_000, Math.max(1, deadline - Date.now()))),
      );
    }
    if (active === 0) {
      console.log('[worker] shutdown: drained cleanly; no jobs interrupted');
      return;
    }
    if (active > inFlight.size) {
      console.error(
        '[worker] shutdown: waiting for pending dequeue slot(s) to resolve before exit',
      );
      const settled = await waitForReservedDequeues(
        () => active,
        () => inFlight.size,
      );
      if (!settled) {
        console.error(
          '[worker] shutdown: dequeue handoff did not settle; leaving claimed payload for durable orphan recovery',
        );
      }
    }
    if (inFlight.size === 0) return;

    const cancelled = cancelAllActiveReviews('worker_shutdown');
    if (cancelled > 0) console.log(`[worker] shutdown: cancelled ${cancelled} active review(s)`);
    try {
      const killed = killAllCodexChildren();
      if (killed > 0)
        console.log(`[worker] shutdown: killed ${killed} in-flight codex process group(s)`);
    } catch (error) {
      console.warn('[worker] shutdown: codex kill failed:', (error as Error).message);
    }
    const cancelDeadline =
      Date.now() + (dependencies.shutdownCancelMs ?? dependencies.config.worker.shutdownCancelMs);
    while ((inFlight.size > 0 || active > 0) && Date.now() < cancelDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (inFlight.size === 0 && active === 0) {
      console.log('[worker] shutdown: cancelled jobs settled cleanly');
      return;
    }
    try {
      const failed = await failInterruptedJobs(queue, dependencies.db, inFlight);
      console.log(
        `[worker] shutdown: ${failed} interrupted review(s) left failed; no automatic paid-stage replay`,
      );
    } catch (error) {
      console.error('[worker] shutdown handling failed for interrupted jobs', error);
    }
  };
}
