import { existsSync } from 'node:fs';
import type { QueueDepth } from '@orvex-review/queue';
import { createAppDatabase, type AppDatabase } from '@orvex-review/store';
import { setCodexChildListener } from '@orvex-review/review';
import type { ServerConfig } from '../../bootstrap/config.js';
import type { WorkerConfig } from '../../review/worker-types.js';
import { noteActiveChildExit, noteActiveChildSpawn } from '../../active-reviews.js';

// Attribute Codex children to the review that started them. This is module
// initialization rather than a worker-loop side effect, so every entry point
// receives the same monitor behavior exactly once.
setCodexChildListener({
  onSpawn: noteActiveChildSpawn,
  onExit: noteActiveChildExit,
});

let activeGauge: () => number = () => 0;
let queueDepthProvider: (() => Promise<QueueDepth>) | null = null;
let maxConcurrent = 0;

export function registerWorkerMetrics(input: {
  active: () => number;
  depth: () => Promise<QueueDepth>;
  capacity: number;
}): void {
  activeGauge = input.active;
  queueDepthProvider = input.depth;
  maxConcurrent = input.capacity;
}

export function getActiveJobCount(): number {
  return activeGauge();
}

export async function getQueueDepth(): Promise<QueueDepth> {
  if (queueDepthProvider) return queueDepthProvider();
  return { queued: 0, waitingOnPr: 0, inFlight: getActiveJobCount(), oldestQueuedAt: null };
}

export function maxConcurrentReviews(): number {
  return maxConcurrent;
}

/** CLI and worker entry points share the same explicit store snapshot. */
export function createWorkerDatabase(config: Pick<ServerConfig, 'store'>): AppDatabase {
  return createAppDatabase(config.store);
}

export function bindWorkerRuntime(
  config: WorkerConfig,
  runtime: Pick<ServerConfig, 'sandbox'>,
): WorkerConfig {
  return {
    ...config,
    providerDependencies: {
      ...config.providerDependencies,
      codexContainer: runtime.sandbox.codexContainer,
    },
    sandboxRuntime: runtime.sandbox.sandbox,
    runtimeVerifyDependencies: runtime.sandbox.runtimeVerify,
  };
}

export function isDeployDraining(config: Pick<ServerConfig, 'deployDrainPath'>): boolean {
  return existsSync(config.deployDrainPath);
}
