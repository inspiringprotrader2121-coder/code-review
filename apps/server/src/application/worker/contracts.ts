import type { ReviewJobPayload, ReviewQueue } from '@orvex-review/queue';
import type { AppDatabase } from '@orvex-review/store';
import type { ServerConfig } from '../../bootstrap/config.js';
import type { processReviewJob, loadWorkerConfig } from '../../pipeline.js';

/**
 * Composition boundary for the bounded worker runtime. The production path
 * supplies a single immutable server configuration; tests can substitute only
 * the worker action they need to observe.
 */
export interface WorkerLoopDependencies {
  config: ServerConfig;
  db: AppDatabase;
  maxConcurrent?: number;
  pollMs?: number;
  recoveryMs?: number;
  /** Lifecycle-owned schedulers run recovery once per fleet instead of per worker process. */
  enablePeriodicRecovery?: boolean;
  isDraining?: () => boolean;
  /** Return false to skip dequeue when the host is short on memory/disk. */
  canAdmitHost?: () => boolean;
  loadConfig?: () => ReturnType<typeof loadWorkerConfig>;
  processReview?: typeof processReviewJob;
  shutdownDrainMs?: number;
  shutdownCancelMs?: number;
}

export interface WorkerExecutionContext {
  queue: ReviewQueue;
  dependencies: WorkerLoopDependencies;
  active: () => number;
  capacity: number;
  inFlight: Set<ReviewJobPayload>;
}

export interface WorkerStopController {
  stop(): Promise<void>;
}
