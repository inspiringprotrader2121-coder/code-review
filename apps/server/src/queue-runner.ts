/**
 * Stable compatibility facade for the queue worker runtime.
 *
 * The implementation lives in `application/worker`: bounded loops, lease
 * fencing, recovery, durable finalization, alerts, and manual admission can
 * now evolve independently without changing server entry points.
 */
export { loadServerRuntimeConfig } from './bootstrap/config.js';
export {
  bindWorkerRuntime,
  createWorkerDatabase,
  getActiveJobCount,
  getQueueDepth,
  isDeployDraining,
  maxConcurrentReviews,
} from './application/worker/runtime.js';
export {
  failInterruptedJobs,
  finalizeQueueJob,
  resolveMaxJobRetries,
  resolveWorkerConcurrency,
  returnLateDequeuedJob,
  shouldReturnDequeuedJob,
  waitForReservedDequeues,
} from './application/worker/queue-policy.js';
export { recoverOrphansAsLeader } from './application/worker/recovery-service.js';
export { enqueueManualReview } from './application/worker/manual-review-service.js';
export type { WorkerLoopDependencies } from './application/worker/contracts.js';
export { startBoundedWorkerLoop as startWorkerLoop } from './application/worker/worker-loop.js';
