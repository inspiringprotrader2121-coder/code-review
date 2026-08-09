export class BillingPeriod {
  static start(periodStart: string | undefined, now = new Date()): string {
    const parsed = periodStart ? new Date(periodStart).getTime() : NaN;
    // A missing or future period must never grant a fresh quota window. Stripe
    // is authoritative when it supplied a usable period; otherwise fall back
    // to the conservative rolling window used before subscription metadata exists.
    if (Number.isFinite(parsed) && parsed <= now.getTime()) return new Date(parsed).toISOString();
    return new Date(now.getTime() - 30 * 24 * 3_600_000).toISOString();
  }
  static timestampToIso(timestamp: number | undefined): string | undefined {
    return typeof timestamp === 'number' && Number.isFinite(timestamp)
      ? new Date(timestamp * 1_000).toISOString()
      : undefined;
  }
  static unlocksPaidEntitlement(status: string | undefined): boolean {
    return status === 'active' || status === 'trialing';
  }
}
