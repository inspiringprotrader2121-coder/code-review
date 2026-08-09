import { prKey, type ReviewQueue } from '@orvex-review/queue';
import { sendOperationalAlert } from '../../alerts.js';

/** Forward durable queue terminal events to the operator sink exactly once per local drain. */
export async function alertQueueOperationalEvents(
  queue: Pick<ReviewQueue, 'drainOperationalEvents'>,
  webhookUrl: string | undefined,
  alert: typeof sendOperationalAlert = sendOperationalAlert,
): Promise<number> {
  const events = queue.drainOperationalEvents?.() ?? [];
  for (const event of events) {
    const record = event.record;
    try {
      await alert(
        {
          event: `queue-dead-lettered:${record.id}`,
          severity: 'critical',
          message: `Review ${prKey(record.job)} entered the dead-letter queue after ${record.reason} (${event.source}); operator replay is required.`,
        },
        webhookUrl,
      );
    } catch (error) {
      console.error('[worker] dead-letter alert failed:', (error as Error).message);
    }
  }
  return events.length;
}
