import assert from 'node:assert/strict';
import test from 'node:test';
import { WebhookDeliveryService, type WebhookDeliveryStore } from './webhook-delivery-service.js';

test('webhook delivery service releases both claims after a failed handler and permits a retry', () => {
  const store = memoryStore();
  const service = new WebhookDeliveryService(store, 60_000);
  const first = service.claim({
    deliveryId: 'delivery-1',
    event: 'ping',
    rawBody: '{}',
    bodyHash: 'body-1',
  });
  assert.equal(first.kind, 'claimed');
  if (first.kind !== 'claimed') return;
  service.settle(first, true, 'delivery-1');
  assert.equal(
    service.claim({ deliveryId: 'delivery-1', event: 'ping', rawBody: '{}', bodyHash: 'body-1' })
      .kind,
    'claimed',
  );
});

test('webhook delivery service distinguishes completed delivery and rotated-id body replays', () => {
  const store = memoryStore();
  const service = new WebhookDeliveryService(store, 60_000);
  const first = service.claim({
    deliveryId: 'delivery-1',
    event: 'ping',
    rawBody: '{}',
    bodyHash: 'body-1',
  });
  assert.equal(first.kind, 'claimed');
  if (first.kind !== 'claimed') return;
  service.settle(first, false, 'delivery-1');
  assert.equal(
    service.claim({ deliveryId: 'delivery-1', event: 'ping', rawBody: '{}', bodyHash: 'body-1' })
      .kind,
    'completed_delivery',
  );
  assert.equal(
    service.claim({ deliveryId: 'delivery-2', event: 'ping', rawBody: '{}', bodyHash: 'body-1' })
      .kind,
    'completed_body',
  );
});

function memoryStore(): WebhookDeliveryStore {
  const events = new Map<string, { processedAt?: string; token?: string }>();
  const key = (provider: string, id: string) => `${provider}:${id}`;
  return {
    claimWebhookEvent(provider, id) {
      const event = events.get(key(provider, id));
      if (event) return null;
      const token = `${provider}-${id}-claim`;
      events.set(key(provider, id), { token });
      return token;
    },
    claimWebhookBodyHash(provider, hash) {
      return this.claimWebhookEvent(provider, hash);
    },
    completeWebhookEvent(provider, id) {
      const event = events.get(key(provider, id));
      if (event) event.processedAt = 'now';
    },
    getWebhookEvent(provider, id) {
      const event = events.get(key(provider, id));
      return event ? ({ processedAt: event.processedAt ?? null } as never) : null;
    },
    releaseWebhookEvent(provider, id) {
      events.delete(key(provider, id));
    },
    webhookBodyProvider(provider) {
      return provider;
    },
  };
}
