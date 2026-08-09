import assert from 'node:assert/strict';
import test from 'node:test';
import type { ReviewQueue } from '@orvex-review/queue';
import type { AppDatabase } from '@orvex-review/store';
import { startApplicationLifecycle } from './lifecycle.js';
import { testServerConfig } from './test-config.js';

test('startup recovery precedes worker start and shutdown order is idempotent', async () => {
  const events: string[] = [];
  const db = {
    failStaleRunningRuns: ({ staleAfterMs }: { staleAfterMs: number }) => {
      events.push(`stale:${staleAfterMs}`);
      return 2;
    },
    pruneEphemeralData: () => {
      events.push('prune');
      return 1;
    },
  } as unknown as AppDatabase;
  const queue = {
    recoverOrphans: async () => {
      events.push('recover');
      return 3;
    },
    close: async () => {
      events.push('queue-close');
    },
  } as unknown as ReviewQueue;

  const lifecycle = await startApplicationLifecycle(
    db,
    queue,
    { ...testServerConfig(), staleRunMs: 90_000 },
    {
      prepareSandboxRuntime: async () => {
        events.push('sandbox');
        return { enabled: true, removedContainers: 2, image: 'runtime@sha256:test' };
      },
      cleanupCheckouts: () => {
        events.push('cleanup');
        return 0;
      },
      startWorker: () => {
        events.push('worker-start');
        return async () => {
          events.push('worker-stop');
        };
      },
      startNightly: () => {
        events.push('nightly-start');
        return () => {
          events.push('nightly-stop');
        };
      },
      sendAlert: async () => false,
      log: { log: () => {}, error: () => {} },
    },
  );

  assert.deepEqual(events, [
    'sandbox',
    'cleanup',
    'stale:90000',
    'prune',
    'recover',
    'worker-start',
    'nightly-start',
  ]);

  await lifecycle.shutdown();
  await lifecycle.shutdown();
  assert.deepEqual(events.slice(-3), ['nightly-stop', 'worker-stop', 'queue-close']);
});

test('enabled sandbox preparation failure prevents all recovery and worker startup', async () => {
  const events: string[] = [];
  const alerts: string[] = [];
  const db = {
    failStaleRunningRuns: () => {
      events.push('stale');
      return 0;
    },
    pruneEphemeralData: () => {
      events.push('prune');
      return 0;
    },
  } as unknown as AppDatabase;
  const queue = {
    recoverOrphans: async () => {
      events.push('recover');
      return 0;
    },
  } as unknown as ReviewQueue;

  await assert.rejects(
    startApplicationLifecycle(
      db,
      queue,
      { ...testServerConfig(), staleRunMs: 60_000 },
      {
        prepareSandboxRuntime: async () => {
          throw new Error('docker timeout');
        },
        cleanupCheckouts: () => {
          events.push('cleanup');
          return 0;
        },
        startWorker: () => {
          events.push('worker-start');
          return async () => {};
        },
        startNightly: () => {
          events.push('nightly-start');
          return () => {};
        },
        sendAlert: async (input) => {
          alerts.push(`${input.event}:${input.severity}`);
          return true;
        },
        log: { log: () => {}, error: () => {} },
      },
    ),
    /docker timeout/,
  );
  assert.deepEqual(events, []);
  assert.deepEqual(alerts, ['internal-sandbox-startup-failed:critical']);
});

test('failed queue recovery alerts and prevents worker startup', async () => {
  const alerts: string[] = [];
  const db = {
    failStaleRunningRuns: () => 0,
    pruneEphemeralData: () => 0,
  } as unknown as AppDatabase;
  const queue = {
    recoverOrphans: async () => {
      throw new Error('redis unavailable');
    },
  } as unknown as ReviewQueue;

  await assert.rejects(
    startApplicationLifecycle(
      db,
      queue,
      { ...testServerConfig(), staleRunMs: 60_000 },
      {
        cleanupCheckouts: () => 0,
        startWorker: () => {
          throw new Error('worker must not start');
        },
        startNightly: () => () => {},
        prepareSandboxRuntime: async () => ({ enabled: false, removedContainers: 0 }),
        sendAlert: async (input) => {
          alerts.push(`${input.event}:${input.severity}`);
          return true;
        },
        log: { log: () => {}, error: () => {} },
      },
    ),
    /redis unavailable/,
  );
  assert.deepEqual(alerts, ['queue-recovery-failed:critical']);
});
