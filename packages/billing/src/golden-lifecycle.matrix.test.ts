import assert from 'node:assert/strict';
import test from 'node:test';
import { AppDatabase } from '@orvex-review/store';
import { UsageReservation } from './usage-reservation.js';

test('golden prepaid lifecycle matrix reserves, settles, refunds, and remains tenant-isolated', () => {
  const store = new AppDatabase(':memory:');
  const primary = store.createTenant('billing-primary');
  const isolated = store.createTenant('billing-isolated');
  const reservations = new UsageReservation(store);
  reservations.creditTopUp({
    tenantId: primary.id,
    amountCents: 500,
    stripeSessionId: 'phase-zero-credit',
    note: 'matrix',
  });

  assert.equal(
    reservations.reserveOverage({
      tenantId: isolated.id,
      runId: 'missing-balance',
      amountCents: 50,
    }),
    false,
    'an isolated empty wallet cannot reserve overage',
  );
  assert.equal(reservations.balanceCents(isolated.id), 0);

  assert.equal(
    reservations.reserveOverage({ tenantId: primary.id, runId: 'reserved', amountCents: 50 }),
    true,
  );
  assert.equal(reservations.balanceCents(primary.id), 450);
  assert.equal(
    reservations.refundUnusedReservation('reserved'),
    true,
    'unconsumed reservation is refundable',
  );
  assert.equal(reservations.balanceCents(primary.id), 500);
  assert.equal(reservations.refundUnusedReservation('reserved'), false, 'refund is idempotent');
  store.close();
});
