import assert from 'node:assert/strict';
import test from 'node:test';
import { AppDatabase } from './database.js';

test('prepaid top-up is idempotent on stripe session id', () => {
  const d = new AppDatabase(':memory:');
  const tenant = d.createTenant('credits-1');
  const first = d.creditPrepaidTopUp({
    tenantId: tenant.id,
    amountCents: 2500,
    stripeSessionId: 'cs_abc',
  });
  assert.equal(first.applied, true);
  assert.equal(first.balanceCents, 2500);
  const second = d.creditPrepaidTopUp({
    tenantId: tenant.id,
    amountCents: 2500,
    stripeSessionId: 'cs_abc',
  });
  assert.equal(second.applied, false);
  assert.equal(second.balanceCents, 2500);
});

test('overage debit refuses when balance is too low and refunds unused reservations', () => {
  const d = new AppDatabase(':memory:');
  const tenant = d.createTenant('credits-2');
  d.creditPrepaidTopUp({
    tenantId: tenant.id,
    amountCents: 50,
    stripeSessionId: 'cs_small',
  });
  assert.equal(d.debitOverageCredits(tenant.id, 'run-1', 75), false);
  assert.equal(d.getCreditBalanceCents(tenant.id), 50);
  assert.equal(d.debitOverageCredits(tenant.id, 'run-2', 50), true);
  assert.equal(d.getCreditBalanceCents(tenant.id), 0);
  assert.equal(d.refundOverageCredits('run-2'), true);
  assert.equal(d.getCreditBalanceCents(tenant.id), 50);
  assert.equal(d.refundOverageCredits('run-2'), false, 'second refund is a no-op');
});

test('tryReserveReviewRun debits prepaid overage atomically', () => {
  const d = new AppDatabase(':memory:');
  const tenant = d.createTenant('credits-3');
  d.creditPrepaidTopUp({
    tenantId: tenant.id,
    amountCents: 100,
    stripeSessionId: 'cs_reserve',
  });
  const reserved = d.tryReserveReviewRun(
    {
      tenantId: tenant.id,
      installationId: 1,
      owner: 'acme',
      repo: 'r',
      pr: 1,
      headSha: 'abc',
      action: 'opened',
      overageDebitCents: 50,
    },
    () => null,
  );
  assert.equal(reserved.ok, true);
  assert.equal(d.getCreditBalanceCents(tenant.id), 50);
});

test('computeOverageDebit runs inside the reservation transaction', () => {
  const d = new AppDatabase(':memory:');
  const tenant = d.createTenant('credits-4');
  d.creditPrepaidTopUp({
    tenantId: tenant.id,
    amountCents: 200,
    stripeSessionId: 'cs_compute',
  });
  let calls = 0;
  const reserved = d.tryReserveReviewRun(
    {
      tenantId: tenant.id,
      installationId: 1,
      owner: 'acme',
      repo: 'r',
      pr: 2,
      headSha: 'def',
      action: 'opened',
      computeOverageDebit: () => {
        calls += 1;
        return 75;
      },
    },
    () => null,
  );
  assert.equal(reserved.ok, true);
  assert.equal(calls, 1);
  assert.equal(d.getCreditBalanceCents(tenant.id), 125);
});

test('Stripe refund clawback removes only unused wallet balance', () => {
  const d = new AppDatabase(':memory:');
  const tenant = d.createTenant('credits-5');
  d.creditPrepaidTopUp({
    tenantId: tenant.id,
    amountCents: 1000,
    stripeSessionId: 'cs_top',
  });
  assert.equal(d.debitOverageCredits(tenant.id, 'run-spend', 400), true);
  const clawed = d.clawbackPrepaidCredits({
    tenantId: tenant.id,
    amountCents: 1000,
    stripeSessionId: 'refund:evt_1',
  });
  assert.equal(clawed.applied, true);
  assert.equal(clawed.clawedCents, 600);
  assert.equal(clawed.balanceCents, 0);
  const again = d.clawbackPrepaidCredits({
    tenantId: tenant.id,
    amountCents: 1000,
    stripeSessionId: 'refund:evt_1',
  });
  assert.equal(again.applied, false);
});

test('reconcileOverageDebit reduces a deep reservation to one unit', () => {
  const d = new AppDatabase(':memory:');
  const tenant = d.createTenant('credits-6');
  d.creditPrepaidTopUp({
    tenantId: tenant.id,
    amountCents: 200,
    stripeSessionId: 'cs_deep',
  });
  assert.equal(d.debitOverageCredits(tenant.id, 'run-deep', 100), true);
  assert.equal(d.reconcileOverageDebit('run-deep', 50), true);
  assert.equal(d.getCreditBalanceCents(tenant.id), 150);
  assert.equal(d.overageDebitNetCents('run-deep'), 50);
  assert.equal(d.reconcileOverageDebit('run-deep', 50), false);
});
