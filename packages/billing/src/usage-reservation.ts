import type { BillingStore } from './ports.js';

export class UsageReservation {
  constructor(private readonly store: BillingStore) {}
  balanceCents(tenantId: string): number {
    return this.store.getCreditBalanceCents(tenantId);
  }
  creditTopUp(input: {
    tenantId: string;
    amountCents: number;
    stripeSessionId: string;
    note: string;
  }) {
    return this.store.creditPrepaidTopUp(input);
  }
  reserveOverage(input: {
    tenantId: string;
    runId: string;
    amountCents: number;
    note?: string;
  }): boolean {
    return this.store.debitOverageCredits(
      input.tenantId,
      input.runId,
      input.amountCents,
      input.note,
    );
  }
  refundUnusedReservation(runId: string, note?: string): boolean {
    return this.store.refundOverageCredits(runId, note);
  }
}
