export const DEFAULT_TPM_WINDOW_MS = 60_000;
export const DEFAULT_TPM_RESERVE_TTL_MS = 960_000;

export interface TpmReserveInput {
  lane: string;
  tokens: number;
  budget: number;
  windowMs?: number;
  reservationId: string;
  reserveTtlMs?: number;
}

export interface TpmReserveResult {
  ok: boolean;
  used: number;
}

/** Rolling-minute token window plus in-flight reservations for one process. */
export class InMemoryTpmWindow {
  private committed: Array<{ lane: string; at: number; tokens: number }> = [];
  private reservations = new Map<string, { lane: string; tokens: number; expiresAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  tryReserve(input: TpmReserveInput): TpmReserveResult {
    const now = this.now();
    const windowMs = input.windowMs ?? DEFAULT_TPM_WINDOW_MS;
    this.prune(input.lane, now, windowMs);
    const used = this.used(input.lane, now, windowMs);
    const tokens = Math.max(0, Math.floor(input.tokens));
    if (used + tokens > input.budget) return { ok: false, used };
    this.reservations.set(input.reservationId, {
      lane: input.lane,
      tokens,
      expiresAt: now + (input.reserveTtlMs ?? DEFAULT_TPM_RESERVE_TTL_MS),
    });
    return { ok: true, used: used + tokens };
  }

  commit(input: {
    lane: string;
    reservationId: string;
    actualTokens: number;
    windowMs?: number;
  }): void {
    const now = this.now();
    const reservation = this.reservations.get(input.reservationId);
    this.reservations.delete(input.reservationId);
    const actual = Math.max(0, Math.floor(input.actualTokens));
    if (actual > 0)
      this.committed.push({ lane: reservation?.lane ?? input.lane, at: now, tokens: actual });
    this.prune(input.lane, now, input.windowMs ?? DEFAULT_TPM_WINDOW_MS);
  }

  used(lane: string, now = this.now(), windowMs = DEFAULT_TPM_WINDOW_MS): number {
    this.prune(lane, now, windowMs);
    let total = 0;
    for (const row of this.committed) if (row.lane === lane) total += row.tokens;
    for (const row of this.reservations.values()) if (row.lane === lane) total += row.tokens;
    return total;
  }

  reset(): void {
    this.committed = [];
    this.reservations.clear();
  }

  private prune(lane: string, now: number, windowMs: number): void {
    const cutoff = now - windowMs;
    this.committed = this.committed.filter((row) => row.lane !== lane || row.at >= cutoff);
    for (const [id, row] of this.reservations) {
      if (row.lane === lane && row.expiresAt <= now) this.reservations.delete(id);
    }
  }
}

export const localProviderTpm = new InMemoryTpmWindow();
