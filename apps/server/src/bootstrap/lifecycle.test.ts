import assert from 'node:assert/strict';
import test from 'node:test';
import type { ReviewQueue } from '@orvex-review/queue';
import type { AppDatabase } from '@orvex-review/store';
import { startApplicationLifecycle } from './lifecycle.js';

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
    close: async () => { events.push('queue-close'); },
  } as unknown as ReviewQueue;

  const lifecycle = await startApplicationLifecycle(db, queue, 90_000, {
    cleanupCheckouts: () => {
      events.push('cleanup');
      return 0;
    },
    startWorker: () => {
      events.push('worker-start');
      return async () => { events.push('worker-stop'); };
    },
    startNightly: () => {
      events.push('nightly-start');
      return () => { events.push('nightly-stop'); };
    },
    retryMeterEvents: async () => undefined,
    sendAlert: async () => false,
    log: { log: () => {}, error: () => {} },
  });

  assert.deepEqual(events, [
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

test('failed queue recovery alerts and prevents worker startup', async () => {
  const alerts: string[] = [];
  const db = {
    failStaleRunningRuns: () => 0,
    pruneEphemeralData: () => 0,
  } as unknown as AppDatabase;
  const queue = {
    recoverOrphans: async () => { throw new Error('redis unavailable'); },
  } as unknown as ReviewQueue;

  await assert.rejects(
    startApplicationLifecycle(db, queue, 60_000, {
      cleanupCheckouts: () => 0,
      startWorker: () => { throw new Error('worker must not start'); },
      startNightly: () => () => {},
      retryMeterEvents: async () => undefined,
      sendAlert: async (input) => {
        alerts.push(`${input.event}:${input.severity}`);
        return true;
      },
      log: { log: () => {}, error: () => {} },
    }),
    /redis unavailable/,
  );
  assert.deepEqual(alerts, ['queue-recovery-failed:critical']);
});
