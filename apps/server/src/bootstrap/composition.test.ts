import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryReviewQueue, providerAdmissionFor } from '@orvex-review/queue';
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
  const body = (await response.json()) as { ok: boolean };
  assert.equal(body.ok, true);
});

test('composition injects the dedicated provider-admission adapter', () => {
  const db = new AppDatabase(':memory:');
  let configured: LlmProviderCoordinator | undefined;
  const queue = new MemoryReviewQueue();
  const admission = providerAdmissionFor(queue);
  assert.ok(admission);
  composeApplication(loadServerRuntimeConfig({}), {
    db,
    queue,
    configureProviderCoordinator: (coordinator) => {
      configured = coordinator;
    },
  });
  assert.equal(configured, admission);
  assert.notEqual(configured, queue);
});
