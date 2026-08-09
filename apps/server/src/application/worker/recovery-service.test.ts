import assert from 'node:assert/strict';
import test from 'node:test';
import { startPeriodicRecovery } from './recovery-service.js';

test(
  'periodic leader recovery alerts on failure without changing queue ownership',
  { timeout: 10_000 },
  async () => {
    const alerts: string[] = [];
    let resolveAlert!: () => void;
    const alertSent = new Promise<void>((resolve) => {
      resolveAlert = resolve;
    });
    let calls = 0;
    let releases = 0;
    const stop = startPeriodicRecovery({
      queue: {
        async acquireRecoveryLease() {
          return 'recovery-owner';
        },
        async recoverOrphans() {
          calls++;
          throw new Error('redis unavailable');
        },
        async releaseRecoveryLease() {
          releases++;
        },
      },
      config: { alerts: { webhookUrl: 'https://alerts.invalid/worker' } },
      intervalMs: 1,
      alert: async (input) => {
        alerts.push(`${input.event}:${input.severity}:${input.message}`);
        resolveAlert();
        return true;
      },
      log: { error: () => {} },
    });

    try {
      await alertSent;
      assert.ok(calls >= 1);
      assert.ok(releases >= 1, 'failed recovery releases its token-CAS lease');
      assert.match(alerts[0]!, /^periodic-queue-recovery-failed:critical:/);
    } finally {
      stop();
    }
  },
);

test(
  'periodic recovery forwards durable dead-letter events to operators',
  { timeout: 10_000 },
  async () => {
    const alerts: string[] = [];
    let resolveAlert!: () => void;
    const alertSent = new Promise<void>((resolve) => {
      resolveAlert = resolve;
    });
    let drained = false;
    const payload = {
      installationId: 1,
      tenantId: 'tenant',
      owner: 'acme',
      repo: 'api',
      pr: 7,
      headSha: 'dead-lettered',
      action: 'opened' as const,
      enqueuedAt: new Date(0).toISOString(),
    };
    const stop = startPeriodicRecovery({
      queue: {
        async recoverOrphans() {
          return 0;
        },
        drainOperationalEvents() {
          if (drained) return [];
          drained = true;
          return [
            {
              type: 'dead-lettered' as const,
              source: 'orphan-recovery' as const,
              record: {
                id: 'dead-1',
                job: payload,
                reason: 'resume_limit_exceeded' as const,
                failedAt: new Date(1).toISOString(),
                attempts: 1,
              },
            },
          ];
        },
      },
      config: { alerts: { webhookUrl: 'https://alerts.invalid/worker' } },
      intervalMs: 1,
      alert: async (input) => {
        alerts.push(`${input.event}:${input.message}`);
        resolveAlert();
        return true;
      },
      log: { error: () => {} },
    });

    try {
      await alertSent;
      assert.equal(alerts.length, 1);
      assert.match(alerts[0]!, /^queue-dead-lettered:dead-1:/);
      assert.match(alerts[0]!, /operator replay is required/);
    } finally {
      stop();
    }
  },
);
