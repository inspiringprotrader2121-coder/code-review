import { randomUUID } from 'node:crypto';
import type { BillingConnection } from './shared.js';

/** Immutable, tenant-scoped prepaid-credit ledger operations. */
export class SqlitePrepaidWalletRepository {
  constructor(private readonly db: BillingConnection) {}

  getCreditBalanceCents(tenantId: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(amount_cents), 0) AS n FROM tenant_credit_ledger WHERE tenant_id = ?`,
      )
      .get(tenantId) as { n: number };
    return Number(row.n) || 0;
  }

  creditPrepaidTopUp(input: {
    tenantId: string;
    amountCents: number;
    stripeSessionId: string;
    note?: string;
  }): { applied: boolean; balanceCents: number } {
    if (!Number.isFinite(input.amountCents) || input.amountCents <= 0) {
      throw new Error('credit top-up amount must be a positive integer (cents)');
    }
    const amount = Math.floor(input.amountCents);
    const existing = this.db
      .prepare(`SELECT id FROM tenant_credit_ledger WHERE stripe_session_id = ?`)
      .get(input.stripeSessionId) as { id: string } | undefined;
    if (existing)
      return { applied: false, balanceCents: this.getCreditBalanceCents(input.tenantId) };

    this.db
      .prepare(
        `INSERT INTO tenant_credit_ledger (id, tenant_id, amount_cents, kind, run_id, stripe_session_id, note, created_at)
         VALUES (?, ?, ?, 'topup', NULL, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        input.tenantId,
        amount,
        input.stripeSessionId,
        input.note ?? null,
        new Date().toISOString(),
      );
    return { applied: true, balanceCents: this.getCreditBalanceCents(input.tenantId) };
  }

  debitOverageCredits(
    tenantId: string,
    runId: string,
    amountCents: number,
    note?: string,
  ): boolean {
    if (!Number.isFinite(amountCents) || amountCents <= 0) return true;
    const amount = Math.floor(amountCents);
    const prior = this.db
      .prepare(`SELECT id FROM tenant_credit_ledger WHERE run_id = ? AND amount_cents < 0`)
      .get(runId) as { id: string } | undefined;
    if (prior) return true;
    if (this.getCreditBalanceCents(tenantId) < amount) return false;
    this.db
      .prepare(
        `INSERT INTO tenant_credit_ledger (id, tenant_id, amount_cents, kind, run_id, stripe_session_id, note, created_at)
         VALUES (?, ?, ?, 'overage_debit', ?, NULL, ?, ?)`,
      )
      .run(randomUUID(), tenantId, -amount, runId, note ?? null, new Date().toISOString());
    return true;
  }

  overageDebitNetCents(runId: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(amount_cents), 0) AS n FROM tenant_credit_ledger WHERE run_id = ?`,
      )
      .get(runId) as { n: number };
    return Math.max(0, -(Number(row.n) || 0));
  }

  refundOverageCredits(runId: string, note?: string): boolean {
    return this.db
      .transaction(() => {
        const debit = this.db
          .prepare(
            `SELECT id, tenant_id FROM tenant_credit_ledger
           WHERE run_id = ? AND kind = 'overage_debit' AND amount_cents < 0`,
          )
          .get(runId) as { id: string; tenant_id: string } | undefined;
        if (!debit) return false;
        const already = this.db
          .prepare(
            `SELECT id FROM tenant_credit_ledger WHERE run_id = ? AND kind = 'overage_refund'`,
          )
          .get(runId) as { id: string } | undefined;
        if (already) return false;
        const net = this.overageDebitNetCents(runId);
        if (net <= 0) return false;
        this.db
          .prepare(
            `INSERT INTO tenant_credit_ledger (id, tenant_id, amount_cents, kind, run_id, stripe_session_id, note, created_at)
           VALUES (?, ?, ?, 'overage_refund', ?, NULL, ?, ?)`,
          )
          .run(
            randomUUID(),
            debit.tenant_id,
            net,
            runId,
            note ?? 'refund unused overage reservation',
            new Date().toISOString(),
          );
        return true;
      })
      .immediate();
  }

  reconcileOverageDebit(runId: string, correctDebitCents: number, note?: string): boolean {
    const correct = Math.max(0, Math.floor(correctDebitCents));
    return this.db
      .transaction(() => {
        const debit = this.db
          .prepare(
            `SELECT tenant_id FROM tenant_credit_ledger
           WHERE run_id = ? AND kind = 'overage_debit' AND amount_cents < 0`,
          )
          .get(runId) as { tenant_id: string } | undefined;
        if (!debit) return false;
        const priorPartial = this.db
          .prepare(
            `SELECT id FROM tenant_credit_ledger WHERE run_id = ? AND kind = 'overage_partial_refund'`,
          )
          .get(runId) as { id: string } | undefined;
        if (priorPartial) return false;
        const net = this.overageDebitNetCents(runId);
        if (net <= correct) return false;
        this.db
          .prepare(
            `INSERT INTO tenant_credit_ledger (id, tenant_id, amount_cents, kind, run_id, stripe_session_id, note, created_at)
           VALUES (?, ?, ?, 'overage_partial_refund', ?, NULL, ?, ?)`,
          )
          .run(
            randomUUID(),
            debit.tenant_id,
            net - correct,
            runId,
            note ?? 'reconcile overage to delivered units',
            new Date().toISOString(),
          );
        return true;
      })
      .immediate();
  }

  clawbackPrepaidCredits(input: {
    tenantId: string;
    amountCents: number;
    stripeSessionId: string;
    note?: string;
  }): { applied: boolean; clawedCents: number; balanceCents: number } {
    const requested = Math.max(0, Math.floor(input.amountCents));
    if (requested <= 0)
      return {
        applied: false,
        clawedCents: 0,
        balanceCents: this.getCreditBalanceCents(input.tenantId),
      };
    return this.db
      .transaction(() => {
        const existing = this.db
          .prepare(`SELECT id FROM tenant_credit_ledger WHERE stripe_session_id = ?`)
          .get(input.stripeSessionId) as { id: string } | undefined;
        if (existing)
          return {
            applied: false,
            clawedCents: 0,
            balanceCents: this.getCreditBalanceCents(input.tenantId),
          };
        const balance = this.getCreditBalanceCents(input.tenantId);
        const clawed = Math.min(balance, requested);
        this.db
          .prepare(
            `INSERT INTO tenant_credit_ledger (id, tenant_id, amount_cents, kind, run_id, stripe_session_id, note, created_at)
           VALUES (?, ?, ?, 'topup_clawback', NULL, ?, ?, ?)`,
          )
          .run(
            randomUUID(),
            input.tenantId,
            -clawed,
            input.stripeSessionId,
            input.note ??
              (clawed > 0 ? 'Stripe refund clawback' : 'refund clawback (no unused balance)'),
            new Date().toISOString(),
          );
        return {
          applied: true,
          clawedCents: clawed,
          balanceCents: this.getCreditBalanceCents(input.tenantId),
        };
      })
      .immediate();
  }
}
