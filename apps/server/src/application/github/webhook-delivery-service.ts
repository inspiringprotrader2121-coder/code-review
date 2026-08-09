import type { MaintenanceRepository } from '@orvex-review/store';

export type WebhookDeliveryStore = Pick<
  MaintenanceRepository,
  | 'claimWebhookBodyHash'
  | 'claimWebhookEvent'
  | 'completeWebhookEvent'
  | 'getWebhookEvent'
  | 'releaseWebhookEvent'
  | 'webhookBodyProvider'
>;

export type WebhookDeliveryClaim =
  | {
      kind: 'claimed';
      deliveryClaim: string;
      bodyClaim: string;
      bodyProvider: string;
      bodyHash: string;
    }
  | { kind: 'completed_delivery' | 'completed_body' | 'busy_delivery' | 'busy_body' };

/** Durable, two-key webhook idempotency. HTTP translates these outcomes to responses. */
export class WebhookDeliveryService {
  constructor(
    private readonly store: WebhookDeliveryStore,
    private readonly bodyDedupTtlMs: number,
  ) {}

  claim(input: {
    deliveryId: string;
    event: string | undefined;
    rawBody: string;
    bodyHash: string;
  }): WebhookDeliveryClaim {
    const deliveryClaim = this.store.claimWebhookEvent('github', input.deliveryId);
    if (!deliveryClaim) {
      return this.store.getWebhookEvent('github', input.deliveryId)?.processedAt
        ? { kind: 'completed_delivery' }
        : { kind: 'busy_delivery' };
    }
    const bodyProvider = this.store.webhookBodyProvider('github');
    const bodyClaim = this.store.claimWebhookBodyHash('github', input.bodyHash, {
      ttlMs: this.bodyDedupTtlMs,
    });
    if (!bodyClaim) {
      this.store.releaseWebhookEvent('github', input.deliveryId, deliveryClaim);
      return this.store.getWebhookEvent(bodyProvider, input.bodyHash)?.processedAt
        ? { kind: 'completed_body' }
        : { kind: 'busy_body' };
    }
    return { kind: 'claimed', deliveryClaim, bodyClaim, bodyProvider, bodyHash: input.bodyHash };
  }

  settle(
    input: Extract<WebhookDeliveryClaim, { kind: 'claimed' }>,
    failed: boolean,
    deliveryId: string,
  ): void {
    const transition = failed ? 'releaseWebhookEvent' : 'completeWebhookEvent';
    this.store[transition](input.bodyProvider, input.bodyHash, input.bodyClaim);
    this.store[transition]('github', deliveryId, input.deliveryClaim);
  }
}
