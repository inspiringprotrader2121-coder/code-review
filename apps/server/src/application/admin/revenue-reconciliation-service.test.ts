import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RevenueReconciliationService,
  type StripeObjectClient,
} from './revenue-reconciliation-service.js';

test('revenue reconciliation records paid invoices and only the uncovered refund delta', async () => {
  const events: Array<{ eventId: string; amountCents: number }> = [];
  const store = {
    listStripeCustomers: () => [{ tenantId: 'tenant-1', customerId: 'cus-1' }],
    sumStripeRefundsForCharge: () => 200,
    recordStripeRevenueEvent: (event: { eventId: string; amountCents: number }) => {
      events.push(event);
      return true;
    },
  };
  const stripe: StripeObjectClient = {
    async list<T>(endpoint: string) {
      if (endpoint === '/v1/invoices')
        return [{ id: 'in-1', amount_paid: 9900, customer: 'cus-1' }] as T[];
      if (endpoint === '/v1/charges')
        return [{ id: 'ch-1', amount_refunded: 500, customer: 'cus-1' }] as T[];
      return [{ id: 're-1', amount: 500, created: 1 }] as T[];
    },
  };
  const result = await new RevenueReconciliationService(store, stripe, () => 'now').reconcile();
  assert.deepEqual(result, { customers: 1, synced: 2, errors: [] });
  assert.deepEqual(
    events.map(({ eventId, amountCents }) => ({ eventId, amountCents })),
    [
      { eventId: 'backfill:in-1', amountCents: 9900 },
      { eventId: 'backfill:refund:re-1', amountCents: -300 },
    ],
  );
});

test('revenue reconciliation records the remaining cumulative refund when refund detail is unavailable', async () => {
  const events: Array<{ eventId: string; amountCents: number }> = [];
  const store = {
    listStripeCustomers: () => [{ tenantId: 'tenant-1', customerId: 'cus-1' }],
    sumStripeRefundsForCharge: () => 0,
    recordStripeRevenueEvent: (event: { eventId: string; amountCents: number }) => {
      events.push(event);
      return true;
    },
  };
  const stripe: StripeObjectClient = {
    async list<T>(endpoint: string) {
      if (endpoint === '/v1/invoices') return [] as T[];
      if (endpoint === '/v1/charges')
        return [{ id: 'ch-1', amount_refunded: 500, customer: 'cus-1', created: 1 }] as T[];
      return [] as T[];
    },
  };
  await new RevenueReconciliationService(store, stripe, () => 'now').reconcile();
  assert.deepEqual(
    events.map(({ eventId, amountCents }) => ({ eventId, amountCents })),
    [{ eventId: 'backfill:refund:ch-1:500', amountCents: -500 }],
  );
});
