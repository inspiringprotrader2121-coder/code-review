import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryReviewQueue, type ReviewQueue } from '@orvex-review/queue';
import type { LlmProviderCoordinator } from '@orvex-review/review';
import { AppDatabase } from '@orvex-review/store';
import { composeApplication } from './composition.js';
import { loadServerRuntimeConfig } from './config.js';

test('composition injects one database and queue into readiness', async () => {
  const db = new AppDatabase(':memory:');
  const queue = new MemoryReviewQueue();
  const services = composeApplication(loadServerRuntimeConfig({ HOST: '127.0.0.1' }), {
    db,
    queue,
  });

  assert.equal(services.db, db);
  assert.equal(services.queue, queue);
  const response = await services.app.request('/ready');
  assert.equal(response.status, 200);
  const body = await response.json() as { ok: boolean };
  assert.equal(body.ok, true);
});

test('composition configures distributed provider coordination only for capable queues', () => {
  const db = new AppDatabase(':memory:');
  let configured: LlmProviderCoordinator | undefined;
  const capable = Object.assign(new MemoryReviewQueue(), {
    acquireProviderLease: async () => 'token',
    releaseProviderLease: async () => {},
    getProviderCooldownMs: async () => 0,
    setProviderCooldown: async () => {},
  }) as ReviewQueue & LlmProviderCoordinator;
  composeApplication(loadServerRuntimeConfig({}), {
    db,
    queue: capable,
    configureProviderCoordinator: (coordinator) => { configured = coordinator; },
  });
  assert.equal(configured, capable);

  configured = undefined;
  composeApplication(loadServerRuntimeConfig({}), {
    db,
    queue: new MemoryReviewQueue(),
    configureProviderCoordinator: (coordinator) => { configured = coordinator; },
  });
  assert.equal(configured, undefined);
});
