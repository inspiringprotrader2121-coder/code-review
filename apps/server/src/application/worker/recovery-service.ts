import type { ReviewQueue } from '@orvex-review/queue';
import type { ServerConfig } from '../../bootstrap/config.js';
import { sendOperationalAlert } from '../../alerts.js';
import { alertQueueOperationalEvents } from './queue-alerts.js';

export const DEFAULT_RECOVERY_MS = 30_000;

/**
 * Redis workers use a distributed leader lease before recovery. The selected
 * leader releases that lease after each pass. Token-CAS release prevents one
 * process from clearing a successor's lease while allowing the 30-second
 * scheduler to elect a leader on every pass.
 */
export async function recoverOrphansAsLeader(
  queue: Pick<ReviewQueue, 'recoverOrphans' | 'acquireRecoveryLease' | 'releaseRecoveryLease'>,
): Promise<number | null> {
  if (!queue.acquireRecoveryLease) return queue.recoverOrphans();
  const token = await queue.acquireRecoveryLease();
  if (!token) return null;
  try {
    return await queue.recoverOrphans();
  } finally {
    await queue.releaseRecoveryLease?.(token);
  }
}

export function startPeriodicRecovery(input: {
  queue: Pick<
    ReviewQueue,
    'recoverOrphans' | 'acquireRecoveryLease' | 'releaseRecoveryLease' | 'drainOperationalEvents'
  >;
  config: Pick<ServerConfig, 'alerts'>;
  intervalMs?: number;
  alert?: typeof sendOperationalAlert;
  log?: Pick<Console, 'error'>;
}): () => void {
  const alert = input.alert ?? sendOperationalAlert;
  const log = input.log ?? console;
  const timer = setInterval(() => {
    void recoverOrphansAsLeader(input.queue)
      .then(() => alertQueueOperationalEvents(input.queue, input.config.alerts.webhookUrl, alert))
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        log.error('[worker] orphan recovery error', error);
        void alert(
          {
            event: 'periodic-queue-recovery-failed',
            severity: 'critical',
            message: `Periodic queue orphan recovery failed: ${message}`,
          },
          input.config.alerts.webhookUrl,
        );
      });
  }, input.intervalMs ?? DEFAULT_RECOVERY_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
