import type { PlatformCost, StripeRevenueEvent } from '../../types.js';
import type { BillingConnection } from './shared.js';

/** Idempotent Stripe revenue/refund ledger and operator-owned platform costs. */
export class SqliteStripeRevenueRepository {
  constructor(private readonly db: BillingConnection) {}

  recordStripeRevenueEvent(
    input: Omit<StripeRevenueEvent, 'createdAt'> & { createdAt?: string },
  ): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO stripe_revenue_events
       (event_id, event_type, invoice_id, tenant_id, customer_id, subscription_id,
        amount_cents, currency, occurred_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.eventId,
        input.eventType,
        input.invoiceId ?? null,
        input.tenantId ?? null,
        input.customerId ?? null,
        input.subscriptionId ?? null,
        input.amountCents,
        input.currency.trim().toLowerCase(),
        input.occurredAt,
        input.createdAt ?? new Date().toISOString(),
      );
    return result.changes > 0;
  }

  assignUnlinkedStripeRevenue(customerId: string, tenantId: string): number {
    if (!customerId.trim() || !tenantId.trim()) return 0;
    return this.db
      .prepare(
        `UPDATE stripe_revenue_events SET tenant_id = ? WHERE customer_id = ? AND tenant_id IS NULL`,
      )
      .run(tenantId, customerId).changes;
  }

  sumStripeRefundsForCharge(chargeId: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(-amount_cents), 0) AS amount_cents
       FROM stripe_revenue_events WHERE event_type = 'charge.refunded' AND invoice_id = ?`,
      )
      .get(chargeId) as { amount_cents: number };
    return Math.max(0, row.amount_cents);
  }

  listPlatformCosts(): PlatformCost[] {
    const rows = this.db
      .prepare(
        `SELECT category, amount_cents, note, updated_at FROM platform_costs ORDER BY category ASC`,
      )
      .all() as Array<{
      category: string;
      amount_cents: number;
      note: string | null;
      updated_at: string;
    }>;
    return rows.map((row) => ({
      category: row.category,
      amountCents: row.amount_cents,
      note: row.note ?? undefined,
      updatedAt: row.updated_at,
    }));
  }

  upsertPlatformCost(input: {
    category: string;
    amountCents: number;
    note?: string;
  }): PlatformCost {
    const updatedAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO platform_costs (category, amount_cents, note, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(category) DO UPDATE SET amount_cents = excluded.amount_cents,
         note = excluded.note, updated_at = excluded.updated_at`,
      )
      .run(input.category, input.amountCents, input.note ?? null, updatedAt);
    return { ...input, updatedAt };
  }

  deletePlatformCost(category: string): boolean {
    return (
      this.db.prepare(`DELETE FROM platform_costs WHERE category = ?`).run(category).changes > 0
    );
  }
}
