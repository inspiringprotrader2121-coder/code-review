import assert from 'node:assert/strict';
import test from 'node:test';
import type { ReviewQueue } from '@orvex-review/queue';
import type { AppDatabase } from '@orvex-review/store';
import { startApplicationLifecycle } from './lifecycle.js';
import { testServerConfig } from './test-config.js';
import type { ProcessRole } from './topology.js';

function configForRole(role: ProcessRole) {
  return { ...testServerConfig(), topology: Object.freeze({ role }) };
}

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

test('api role owns no worker, scheduler, sandbox, or cleanup side effects', async () => {
  const events: string[] = [];
  const lifecycle = await startApplicationLifecycle(
    {} as AppDatabase,
    {
      close: async () => {
        events.push('queue-close');
      },
    } as unknown as ReviewQueue,
    configForRole('api'),
    {
      prepareSandboxRuntime: async () => {
        events.push('sandbox');
        return { enabled: false, removedContainers: 0 };
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
      log: { log: () => {}, error: () => {} },
    },
  );

  assert.deepEqual(events, []);
  await lifecycle.shutdown();
  assert.deepEqual(events, ['queue-close']);
});

test('worker role owns only sandbox preparation, checkout cleanup, and review execution', async () => {
  const events: string[] = [];
  const lifecycle = await startApplicationLifecycle(
    {} as AppDatabase,
    {
      close: async () => {
        events.push('queue-close');
      },
    } as unknown as ReviewQueue,
    configForRole('worker'),
    {
      prepareSandboxRuntime: async () => {
        events.push('sandbox');
        return { enabled: false, removedContainers: 0 };
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
        return () => {};
      },
      log: { log: () => {}, error: () => {} },
    },
  );

  assert.deepEqual(events, ['sandbox', 'cleanup', 'worker-start']);
  await lifecycle.shutdown();
  assert.deepEqual(events, ['sandbox', 'cleanup', 'worker-start', 'worker-stop', 'queue-close']);
});

test('scheduler role owns maintenance, recovery, and nightly scheduling without review execution', async () => {
  const events: string[] = [];
  const lifecycle = await startApplicationLifecycle(
    {
      failStaleRunningRuns: () => {
        events.push('stale');
        return 0;
      },
      pruneEphemeralData: () => {
        events.push('prune');
        return 0;
      },
    } as unknown as AppDatabase,
    {
      recoverOrphans: async () => {
        events.push('recover');
        return 0;
      },
      close: async () => {
        events.push('queue-close');
      },
    } as unknown as ReviewQueue,
    configForRole('scheduler'),
    {
      prepareSandboxRuntime: async () => {
        events.push('sandbox');
        return { enabled: false, removedContainers: 0 };
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
        return () => {
          events.push('nightly-stop');
        };
      },
      log: { log: () => {}, error: () => {} },
    },
  );

  assert.deepEqual(events, ['stale', 'prune', 'recover', 'nightly-start']);
  await lifecycle.shutdown();
  assert.deepEqual(events, [
    'stale',
    'prune',
    'recover',
    'nightly-start',
    'nightly-stop',
    'queue-close',
  ]);
});

test('scheduler establishes Redis provider capacity before a worker can accept paid work', async () => {
  const events: string[] = [];
  const providerAdmission = {
    acquireProviderLease: async () => 'lease',
    releaseProviderLease: async () => {},
    getProviderCooldownMs: async () => 0,
    setProviderCooldown: async () => {},
    initializeProviderCapacities: async () => {
      events.push('capacity-init');
    },
    assertProviderCapacitiesReady: async () => {
      events.push('capacity-assert');
    },
  };
  const lifecycle = await startApplicationLifecycle(
    {
      failStaleRunningRuns: () => {
        events.push('stale');
        return 0;
      },
      pruneEphemeralData: () => {
        events.push('prune');
        return 0;
      },
    } as unknown as AppDatabase,
    {
      providerAdmission,
      recoverOrphans: async () => {
        events.push('recover');
        return 0;
      },
      close: async () => {
        events.push('queue-close');
      },
    } as unknown as ReviewQueue,
    testServerConfig(),
    {
      prepareSandboxRuntime: async () => {
        events.push('sandbox');
        return { enabled: false, removedContainers: 0 };
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
      log: { log: () => {}, error: () => {} },
    },
  );

  assert.deepEqual(events, [
    'sandbox',
    'cleanup',
    'stale',
    'prune',
    'capacity-init',
    'recover',
    'capacity-assert',
    'worker-start',
    'nightly-start',
  ]);
  await lifecycle.shutdown();
});

test('a dedicated worker fails closed before execution when the scheduler capacity plan is absent', async () => {
  const events: string[] = [];
  const alerts: string[] = [];
  const providerAdmission = {
    acquireProviderLease: async () => 'lease',
    releaseProviderLease: async () => {},
    getProviderCooldownMs: async () => 0,
    setProviderCooldown: async () => {},
    initializeProviderCapacities: async () => {},
    assertProviderCapacitiesReady: async () => {
      throw new Error('luna fleet capacity is not registered');
    },
  };

  await assert.rejects(
    startApplicationLifecycle(
      {} as AppDatabase,
      {
        providerAdmission,
      } as unknown as ReviewQueue,
      configForRole('worker'),
      {
        prepareSandboxRuntime: async () => {
          events.push('sandbox');
          return { enabled: false, removedContainers: 0 };
        },
        cleanupCheckouts: () => {
          events.push('cleanup');
          return 0;
        },
        startWorker: () => {
          events.push('worker-start');
          return async () => {};
        },
        sendAlert: async (input) => {
          alerts.push(`${input.event}:${input.severity}`);
          return true;
        },
        log: { log: () => {}, error: () => {} },
      },
    ),
    /fleet capacity is not registered/,
  );

  assert.deepEqual(events, ['sandbox', 'cleanup']);
  assert.deepEqual(alerts, ['provider-capacity-startup-failed:critical']);
});
