import type { BillingRepository, TenancyRepository } from '@orvex-review/store';

type RevenueStore = Pick<TenancyRepository, 'listStripeCustomers'> &
  Pick<BillingRepository, 'recordStripeRevenueEvent' | 'sumStripeRefundsForCharge'>;

export interface StripeObjectClient {
  list<T>(endpoint: string, filters: Record<string, string>): Promise<T[]>;
}

export interface RevenueSyncResult {
  customers: number;
  synced: number;
  errors: string[];
}

/** Reconciles durable revenue records; HTTP and Stripe credentials stay outside this use case. */
export class RevenueReconciliationService {
  constructor(
    private readonly store: RevenueStore,
    private readonly stripe: StripeObjectClient,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async reconcile(): Promise<RevenueSyncResult> {
    let synced = 0;
    const errors: string[] = [];
    const customers = this.store.listStripeCustomers();
    for (const customer of customers) {
      try {
        const invoices = await this.stripe.list<StripeInvoice>('/v1/invoices', {
          customer: customer.customerId,
          status: 'paid',
        });
        for (const invoice of invoices) {
          if (
            !invoice.id ||
            !Number.isFinite(invoice.amount_paid) ||
            (invoice.amount_paid ?? 0) <= 0
          )
            continue;
          if (
            this.store.recordStripeRevenueEvent({
              eventId: `backfill:${invoice.id}`,
              eventType: 'invoice.paid',
              invoiceId: invoice.id,
              tenantId: customer.tenantId,
              customerId: objectId(invoice.customer) ?? customer.customerId,
              subscriptionId: objectId(invoice.subscription),
              amountCents: invoice.amount_paid ?? 0,
              currency: invoice.currency ?? 'usd',
              occurredAt: invoice.status_transitions?.paid_at
                ? new Date(invoice.status_transitions.paid_at * 1000).toISOString()
                : this.now(),
            })
          )
            synced++;
        }

        const charges = await this.stripe.list<StripeCharge>('/v1/charges', {
          customer: customer.customerId,
        });
        for (const charge of charges) {
          if (!charge.id) continue;
          const cumulative = Math.max(0, Number(charge.amount_refunded ?? 0));
          const prior = this.store.sumStripeRefundsForCharge(charge.id);
          const delta = Math.max(0, cumulative - prior);
          if (delta <= 0) continue;

          const refunds = await this.stripe.list<StripeRefund>('/v1/refunds', {
            charge: charge.id,
          });
          let uncovered = prior;
          let recorded = 0;
          for (const refund of [...refunds].sort((a, b) => (a.created ?? 0) - (b.created ?? 0))) {
            const amount = Math.max(0, Number(refund.amount ?? 0));
            const newAmount = amount - Math.min(amount, uncovered);
            uncovered -= Math.min(amount, uncovered);
            if (!refund.id || newAmount <= 0) continue;
            if (
              this.store.recordStripeRevenueEvent({
                eventId: `backfill:refund:${refund.id}`,
                eventType: 'charge.refunded',
                invoiceId: charge.id,
                tenantId: customer.tenantId,
                customerId: objectId(charge.customer) ?? customer.customerId,
                subscriptionId: objectId(charge.subscription),
                amountCents: -newAmount,
                currency: refund.currency ?? charge.currency ?? 'usd',
                occurredAt: refund.created
                  ? new Date(refund.created * 1000).toISOString()
                  : this.now(),
              })
            ) {
              synced++;
              recorded += newAmount;
            }
          }
          if (
            recorded < delta &&
            this.store.recordStripeRevenueEvent({
              eventId: `backfill:refund:${charge.id}:${cumulative}`,
              eventType: 'charge.refunded',
              invoiceId: charge.id,
              tenantId: customer.tenantId,
              customerId: objectId(charge.customer) ?? customer.customerId,
              subscriptionId: objectId(charge.subscription),
              amountCents: -(delta - recorded),
              currency: charge.currency ?? 'usd',
              occurredAt: charge.created
                ? new Date(charge.created * 1000).toISOString()
                : this.now(),
            })
          )
            synced++;
        }
      } catch (error) {
        errors.push(`${customer.customerId}: ${(error as Error).message}`);
      }
    }
    return { customers: customers.length, synced, errors };
  }
}

interface StripeInvoice {
  id?: string;
  amount_paid?: number;
  currency?: string;
  customer?: StripeReference;
  subscription?: StripeReference;
  status_transitions?: { paid_at?: number };
}
interface StripeCharge {
  id?: string;
  amount_refunded?: number;
  currency?: string;
  customer?: StripeReference;
  subscription?: StripeReference;
  created?: number;
}
interface StripeRefund {
  id?: string;
  amount?: number;
  currency?: string;
  created?: number;
}
type StripeReference = string | { id?: string } | undefined;

function objectId(value: StripeReference): string | undefined {
  return typeof value === 'string' ? value : value?.id;
}

export function stripeObjectClient(
  secret: string,
  request: typeof fetch = fetch,
): StripeObjectClient {
  return {
    async list<T>(endpoint: string, filters: Record<string, string>) {
      const objects: T[] = [];
      let startingAfter: string | undefined;
      for (let page = 0; page < 1000; page++) {
        const query = new URLSearchParams({ ...filters, limit: '100' });
        if (startingAfter) query.set('starting_after', startingAfter);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15_000);
        let response: Response;
        try {
          response = await request(`https://api.stripe.com${endpoint}?${query}`, {
            signal: controller.signal,
            headers: { Authorization: `Bearer ${secret}` },
          });
        } finally {
          clearTimeout(timer);
        }
        if (!response.ok) throw new Error(`Stripe ${endpoint} ${response.status}`);
        const payload = (await response.json()) as { data?: T[]; has_more?: boolean };
        const items = payload.data ?? [];
        objects.push(...items);
        if (!payload.has_more || items.length === 0) break;
        const last = items.at(-1) as T & { id?: string };
        if (!last?.id) break;
        startingAfter = last.id;
        if (page === 999) throw new Error(`Stripe ${endpoint} pagination exceeded 1000 pages`);
      }
      return objects;
    },
  };
}
