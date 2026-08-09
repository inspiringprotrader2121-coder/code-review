import assert from 'node:assert/strict';
import test from 'node:test';
import type { ReviewJobPayload } from '@orvex-review/queue';
import { startLeaseHeartbeat } from './lease-heartbeat.js';

const job = {
  installationId: 4,
  tenantId: 'tenant',
  owner: 'acme',
  repo: 'api',
  pr: 12,
  headSha: 'abc123',
  action: 'opened',
  enqueuedAt: new Date(0).toISOString(),
} satisfies ReviewJobPayload;

test('lease ownership loss is sticky and stops publication fencing', async () => {
  let renewals = 0;
  const heartbeat = startLeaseHeartbeat({
    queue: {
      async renewLease() {
        renewals++;
        throw new Error('lease lost for claim token');
      },
    },
    job,
    renewMs: 60_000,
    log: { warn: () => {} },
  });

  assert.equal(await heartbeat.leaseValid(), false);
  assert.equal(await heartbeat.leaseValid(), false);
  assert.equal(renewals, 1, 'a known ownership loss is never retried as a transient failure');
  heartbeat.stop();
});

test('two transient Redis renewal failures preserve the completed review claim', async () => {
  let renewals = 0;
  const heartbeat = startLeaseHeartbeat({
    queue: {
      async renewLease() {
        renewals++;
        throw new Error('redis connection reset');
      },
    },
    job,
    renewMs: 60_000,
    log: { warn: () => {} },
  });

  assert.equal(await heartbeat.leaseValid(), true);
  assert.equal(renewals, 2, 'one live check receives one bounded retry');
  heartbeat.stop();
});

test('a transient renewal can recover before finalization', async () => {
  let renewals = 0;
  const heartbeat = startLeaseHeartbeat({
    queue: {
      async renewLease() {
        renewals++;
        if (renewals === 1) throw new Error('redis timeout');
      },
    },
    job,
    renewMs: 60_000,
    log: { warn: () => {} },
  });

  assert.equal(await heartbeat.leaseValid(), true);
  assert.equal(renewals, 2);
  heartbeat.stop();
});
