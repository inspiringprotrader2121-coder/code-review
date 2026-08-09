import type { ReviewQueue } from '@orvex-review/queue';
import type { AppDatabase } from '@orvex-review/store';
import { sendOperationalAlert } from '../alerts.js';
import { startNightlyScheduler } from '../nightly.js';
import { loadWorkerConfig } from '../pipeline.js';
import { recoverOrphansAsLeader, startWorkerLoop } from '../queue-runner.js';
import { alertQueueOperationalEvents } from '../application/worker/queue-alerts.js';
import { prepareSandboxRuntimeForStartup, type SandboxStartupPreparation } from '../sandbox.js';
import { cleanupAbandonedAgentCheckouts } from '../temp-cleanup.js';
import type { ServerConfig } from './config.js';

const DAILY_MS = 24 * 3_600_000;

export interface ApplicationLifecycleDependencies {
  cleanupCheckouts?: () => number;
  sendAlert?: typeof sendOperationalAlert;
  startNightly?: (queue: ReviewQueue, config: ServerConfig) => () => void;
  startWorker?: (queue: ReviewQueue, config: ServerConfig) => () => Promise<void>;
  prepareSandboxRuntime?: () => Promise<SandboxStartupPreparation>;
  log?: Pick<Console, 'log' | 'error'>;
}

export interface ApplicationLifecycle {
  shutdown(): Promise<void>;
}

export async function startApplicationLifecycle(
  db: AppDatabase,
  queue: ReviewQueue,
  config: ServerConfig,
  dependencies: ApplicationLifecycleDependencies = {},
): Promise<ApplicationLifecycle> {
  const cleanupCheckouts = dependencies.cleanupCheckouts ?? cleanupAbandonedAgentCheckouts;
  const alert = dependencies.sendAlert ?? sendOperationalAlert;
  const log = dependencies.log ?? console;

  try {
    const sandbox = await (
      dependencies.prepareSandboxRuntime ??
      (() => prepareSandboxRuntimeForStartup({ runtime: config.sandbox.sandbox }))
    )();
    if (sandbox.enabled && sandbox.removedContainers > 0) {
      log.log(
        `[server] removed ${sandbox.removedContainers} orphaned internal sandbox container(s)`,
      );
    }
  } catch (err) {
    log.error('[server] internal sandbox startup preparation failed', err);
    void alert({
      event: 'internal-sandbox-startup-failed',
      severity: 'critical',
      message: `Internal sandbox cleanup/readiness failed during startup: ${(err as Error).message}`,
    });
    throw err;
  }

  const abandonedCheckouts = cleanupCheckouts();
  if (abandonedCheckouts > 0) {
    log.log(`[server] removed ${abandonedCheckouts} abandoned agent checkout(s)`);
  }
  const tempCleanupTimer = setInterval(() => {
    const removed = cleanupCheckouts();
    if (removed > 0) {
      log.log(
        `[server] removed ${removed} abandoned agent temp director${removed === 1 ? 'y' : 'ies'}`,
      );
    }
  }, DAILY_MS);
  tempCleanupTimer.unref();

  const staleRuns = db.failStaleRunningRuns({ staleAfterMs: config.staleRunMs });
  if (staleRuns > 0) log.log(`[server] cleared ${staleRuns} stale 'running' review row(s)`);

  const pruneOnce = (): void => {
    try {
      const pruned = db.pruneEphemeralData();
      if (pruned > 0) log.log(`[server] pruned ${pruned} ephemeral row(s)`);
    } catch (err) {
      log.error('[server] prune failed', err);
      void alert({
        event: 'database-prune-failed',
        severity: 'warning',
        message: `Ephemeral database cleanup failed: ${(err as Error).message}`,
      });
    }
  };
  pruneOnce();
  const pruneTimer = setInterval(pruneOnce, DAILY_MS);
  pruneTimer.unref();

  try {
    const recovered = await recoverOrphansAsLeader(queue);
    if (recovered !== null && recovered > 0) {
      log.log(`[server] recovered ${recovered} orphaned/pending queue item(s)`);
    }
    await alertQueueOperationalEvents(queue, config.alerts.webhookUrl, alert);
  } catch (err) {
    log.error('[server] queue recovery failed', err);
    void alert({
      event: 'queue-recovery-failed',
      severity: 'critical',
      message: `Queue recovery failed during startup: ${(err as Error).message}`,
    });
    clearInterval(pruneTimer);
    clearInterval(tempCleanupTimer);
    throw err;
  }

  const loadConfig = () => loadWorkerConfig(db, config);
  const stopWorker = dependencies.startWorker
    ? dependencies.startWorker(queue, config)
    : startWorkerLoop(queue, { db, loadConfig, config });
  const stopNightly = dependencies.startNightly
    ? dependencies.startNightly(queue, config)
    : startNightlyScheduler(queue, config, loadConfig);
  let shuttingDown = false;

  return {
    async shutdown(): Promise<void> {
      if (shuttingDown) return;
      shuttingDown = true;
      log.log('[server] shutting down...');
      stopNightly();
      clearInterval(pruneTimer);
      clearInterval(tempCleanupTimer);
      await stopWorker();
      await queue.close();
    },
  };
}
