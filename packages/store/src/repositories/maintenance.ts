import { randomUUID } from 'node:crypto';
import type { SqliteConnection } from '../connection.js';

/** Platform-scoped webhook, abuse, worker-lifecycle, and housekeeping persistence. */
export class SqliteMaintenanceRepository {
  constructor(
    private readonly db: SqliteConnection,
    private readonly workerId: string,
  ) {}

  reconcileTerminalReviewRunAttempts(): number {
    const completedAt = new Date().toISOString();
    return this.db
      .prepare(
        `UPDATE review_run_attempts
         SET outcome = CASE
               WHEN (SELECT status FROM review_runs WHERE id = review_run_attempts.run_id) = 'skipped'
                 THEN 'cancelled'
               ELSE 'failed'
             END,
             error = COALESCE(error, 'parent review ended before attempt completion'),
             completed_at = COALESCE(
               (SELECT completed_at FROM review_runs WHERE id = review_run_attempts.run_id),
               ?
             ),
             duration_ms = MAX(0, CAST((julianday(COALESCE(
               (SELECT completed_at FROM review_runs WHERE id = review_run_attempts.run_id),
               ?
             )) - julianday(started_at)) * 86400000 AS INTEGER))
         WHERE outcome = 'running'
           AND EXISTS (
             SELECT 1 FROM review_runs
             WHERE id = review_run_attempts.run_id AND status <> 'running'
           )`,
      )
      .run(completedAt, completedAt).changes;
  }

  recordAbuseSignal(input: {
    ip?: string | null;
    accountLogin?: string | null;
    tenantSlug?: string | null;
    kind: 'install' | 'login';
  }): void {
    try {
      this.db
        .prepare(
          `INSERT INTO abuse_signals (id, ip, account_login, tenant_slug, kind, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          input.ip ?? null,
          input.accountLogin ?? null,
          input.tenantSlug ?? null,
          input.kind,
          new Date().toISOString(),
        );
    } catch {
      /* signal logging must never break onboarding */
    }
  }

  countDistinctAccountsFromIp(ip: string, sinceMs: number): number {
    if (!ip || ip === 'unknown') return 0;
    const since = new Date(Date.now() - sinceMs).toISOString();
    const row = this.db
      .prepare(
        `SELECT COUNT(DISTINCT account_login) AS n FROM abuse_signals
       WHERE ip = ? AND created_at >= ? AND account_login IS NOT NULL`,
      )
      .get(ip, since) as { n: number };
    return row.n;
  }

  claimWebhookEvent(provider: string, eventId: string, staleMs = 15 * 60_000): string | null {
    const claimedAt = new Date().toISOString();
    const claimToken = randomUUID();
    const inserted = this.db
      .prepare(
        `INSERT OR IGNORE INTO webhook_events (provider, event_id, claimed_at, claim_token, processed_at)
       VALUES (?, ?, ?, ?, NULL)`,
      )
      .run(provider, eventId, claimedAt, claimToken);
    if (inserted.changes > 0) return claimToken;

    const existing = this.db
      .prepare(
        `SELECT claimed_at, claim_token, processed_at FROM webhook_events WHERE provider = ? AND event_id = ?`,
      )
      .get(provider, eventId) as
      | { claimed_at: string; claim_token: string | null; processed_at: string | null }
      | undefined;
    if (!existing || existing.processed_at) return null;
    const claimedTime = Date.parse(existing.claimed_at);
    if (Number.isFinite(claimedTime) && Date.now() - claimedTime < staleMs) return null;

    const reclaimed = this.db
      .prepare(
        `UPDATE webhook_events
       SET claimed_at = ?, claim_token = ?
       WHERE provider = ? AND event_id = ? AND processed_at IS NULL AND claimed_at = ?`,
      )
      .run(claimedAt, claimToken, provider, eventId, existing.claimed_at);
    return reclaimed.changes > 0 ? claimToken : null;
  }

  getWebhookEvent(
    provider: string,
    eventId: string,
  ): { claimedAt: string; processedAt?: string } | null {
    const row = this.db
      .prepare(
        `SELECT claimed_at, processed_at FROM webhook_events WHERE provider = ? AND event_id = ?`,
      )
      .get(provider, eventId) as { claimed_at: string; processed_at: string | null } | undefined;
    if (!row) return null;
    return {
      claimedAt: row.claimed_at,
      processedAt: row.processed_at ?? undefined,
    };
  }

  completeWebhookEvent(provider: string, eventId: string, claimToken: string): void {
    this.db
      .prepare(
        `UPDATE webhook_events
       SET processed_at = ?
       WHERE provider = ? AND event_id = ? AND claim_token = ? AND processed_at IS NULL`,
      )
      .run(new Date().toISOString(), provider, eventId, claimToken);
  }

  releaseWebhookEvent(provider: string, eventId: string, claimToken: string): void {
    this.db
      .prepare(
        `DELETE FROM webhook_events
       WHERE provider = ? AND event_id = ? AND claim_token = ? AND processed_at IS NULL`,
      )
      .run(provider, eventId, claimToken);
  }

  claimWebhookBodyHash(
    provider: string,
    bodyHash: string,
    opts: { ttlMs?: number; staleMs?: number } = {},
  ): string | null {
    if (!bodyHash || bodyHash.length > 128) return null;
    const bodyProvider = `${provider}-body`;
    const ttlMs =
      Number.isFinite(opts.ttlMs) && (opts.ttlMs as number) > 0
        ? Math.min(Math.floor(opts.ttlMs as number), 7 * 24 * 3600_000)
        : 2 * 3600_000;
    const staleMs =
      Number.isFinite(opts.staleMs) && (opts.staleMs as number) > 0
        ? Math.min(Math.floor(opts.staleMs as number), 24 * 3600_000)
        : 15 * 60_000;

    const claimedAt = new Date().toISOString();
    const claimToken = randomUUID();

    return this.db.transaction(() => {
      const existing = this.db
        .prepare(
          `SELECT claimed_at, claim_token, processed_at FROM webhook_events WHERE provider = ? AND event_id = ?`,
        )
        .get(bodyProvider, bodyHash) as
        | { claimed_at: string; claim_token: string | null; processed_at: string | null }
        | undefined;

      if (!existing) {
        this.db
          .prepare(
            `INSERT INTO webhook_events (provider, event_id, claimed_at, claim_token, processed_at)
           VALUES (?, ?, ?, ?, NULL)`,
          )
          .run(bodyProvider, bodyHash, claimedAt, claimToken);
        return claimToken;
      }

      const anchor = existing.processed_at ?? existing.claimed_at;
      const anchorMs = Date.parse(anchor);
      const age = Number.isFinite(anchorMs) ? Date.now() - anchorMs : 0;

      if (existing.processed_at) {
        // Still inside the replay window — reject as duplicate.
        if (age < ttlMs) return null;
        // TTL elapsed: drop the stale hash so a legitimate identical payload
        // (or a later attack outside the window) can claim fresh.
        this.db
          .prepare(`DELETE FROM webhook_events WHERE provider = ? AND event_id = ?`)
          .run(bodyProvider, bodyHash);
        this.db
          .prepare(
            `INSERT INTO webhook_events (provider, event_id, claimed_at, claim_token, processed_at)
           VALUES (?, ?, ?, ?, NULL)`,
          )
          .run(bodyProvider, bodyHash, claimedAt, claimToken);
        return claimToken;
      }

      // In-flight claim: allow reclaim only after the stale window (crashed worker).
      if (age < staleMs) return null;
      const reclaimed = this.db
        .prepare(
          `UPDATE webhook_events
         SET claimed_at = ?, claim_token = ?
         WHERE provider = ? AND event_id = ? AND processed_at IS NULL AND claimed_at = ?`,
        )
        .run(claimedAt, claimToken, bodyProvider, bodyHash, existing.claimed_at);
      return reclaimed.changes > 0 ? claimToken : null;
    })();
  }

  webhookBodyProvider(provider: string): string {
    return `${provider}-body`;
  }

  pingDb(): void {
    this.db.prepare('SELECT 1').get();
  }

  failStaleRunningRuns(opts: { staleAfterMs?: number; nowMs?: number } = {}): number {
    const staleAfterMs = Math.max(60_000, opts.staleAfterMs ?? 15 * 60_000);
    const nowMs = opts.nowMs ?? Date.now();
    const cutoff = new Date(nowMs - staleAfterMs).toISOString();
    return this.db.transaction(() => {
      const completedAt = new Date(nowMs).toISOString();
      const res = this.db
        .prepare(
          `UPDATE review_runs
         SET status = 'skipped', skip_reason = 'interrupted by restart — retried',
             completed_at = ?, worker_id = NULL
         WHERE status = 'running' AND COALESCE(heartbeat_at, created_at) < ?`,
        )
        .run(completedAt, cutoff);
      if (res.changes > 0) this.reconcileTerminalReviewRunAttempts();
      return res.changes;
    })();
  }

  heartbeatReviewRun(id: string): boolean {
    if (!id) return false;
    return (
      this.db
        .prepare(
          `UPDATE review_runs SET heartbeat_at = ?
       WHERE id = ? AND status = 'running' AND worker_id = ?`,
        )
        .run(new Date().toISOString(), id, this.workerId).changes > 0
    );
  }

  interruptReviewRun(id: string): boolean {
    if (!id) return false;
    return this.db
      .transaction(() => {
        const res = this.db
          .prepare(
            `UPDATE review_runs
           SET status = 'skipped', skip_reason = 'interrupted by restart',
               completed_at = ?, worker_id = NULL
           WHERE id = ? AND status = 'running' AND worker_id = ?`,
          )
          .run(new Date().toISOString(), id, this.workerId);
        if (res.changes > 0) {
          // Wallet debit stays until resume completes or is abandoned; resume
          // reuses this run id so a second debit is not charged.
          this.reconcileTerminalReviewRunAttempts();
        }
        return res.changes > 0;
      })
      .immediate();
  }

  pruneEphemeralData(opts: { runRetentionMs?: number; abuseRetentionMs?: number } = {}): number {
    const runCutoff = new Date(
      Date.now() - (opts.runRetentionMs ?? 30 * 24 * 3_600_000),
    ).toISOString();
    const abuseCutoff = new Date(
      Date.now() - (opts.abuseRetentionMs ?? 90 * 24 * 3_600_000),
    ).toISOString();
    const webhookCutoff = new Date(Date.now() - 24 * 3_600_000).toISOString();
    // Body-hash replay keys only need to outlive the capture→replay window.
    // Keep them shorter than delivery ids so identical tiny payloads (ping `{}`)
    // are not blocked for the full 30-day event retention.
    const bodyHashCutoff = new Date(Date.now() - 6 * 3600_000).toISOString();
    const now = new Date().toISOString();
    let n = 0;
    n += this.db.transaction(() => {
      // review_run_usage predates a foreign-key relationship to review_runs;
      // remove its rows explicitly or old interrupted attempts keep inflating
      // the profitability dashboard after their parent run is pruned.
      const usage = this.db
        .prepare(
          `DELETE FROM review_run_usage
         WHERE run_id IN (
           SELECT id FROM review_runs
           WHERE status = 'skipped' AND created_at < ?
         )`,
        )
        .run(runCutoff).changes;
      const runs = this.db
        .prepare(`DELETE FROM review_runs WHERE status = 'skipped' AND created_at < ?`)
        .run(runCutoff).changes;
      // Remove orphaned overage ledger rows only when their net is already zero
      // (debit + refund). Never delete a lone debit — that would inflate balance.
      const ledger = this.db
        .prepare(
          `DELETE FROM tenant_credit_ledger
         WHERE run_id IN (
           SELECT run_id FROM (
             SELECT run_id AS run_id, SUM(amount_cents) AS net
             FROM tenant_credit_ledger
             WHERE run_id IS NOT NULL
               AND run_id NOT IN (SELECT id FROM review_runs)
               AND kind IN ('overage_debit', 'overage_refund', 'overage_partial_refund')
             GROUP BY run_id
             HAVING net = 0
           )
         )`,
        )
        .run().changes;
      return usage + runs + ledger;
    })();
    n += this.db.prepare(`DELETE FROM sessions WHERE expires_at < ?`).run(now).changes;
    n += this.db.prepare(`DELETE FROM mfa_challenges WHERE expires_at < ?`).run(now).changes;
    n += this.db.prepare(`DELETE FROM auth_rate_limits WHERE reset_at < ?`).run(now).changes;
    n += this.db.prepare(`DELETE FROM abuse_signals WHERE created_at < ?`).run(abuseCutoff).changes;
    n += this.db
      .prepare(
        `DELETE FROM webhook_events
       WHERE provider LIKE '%-body'
         AND (
           (processed_at IS NOT NULL AND processed_at < ?)
           OR (processed_at IS NULL AND claimed_at < ?)
         )`,
      )
      .run(bodyHashCutoff, webhookCutoff).changes;
    n += this.db
      .prepare(
        `DELETE FROM webhook_events
       WHERE provider NOT LIKE '%-body'
         AND (
           (processed_at IS NOT NULL AND processed_at < ?)
           OR (processed_at IS NULL AND claimed_at < ?)
         )`,
      )
      .run(runCutoff, webhookCutoff).changes;
    return n;
  }
}

export type MaintenanceRepository = Pick<
  SqliteMaintenanceRepository,
  | 'reconcileTerminalReviewRunAttempts'
  | 'recordAbuseSignal'
  | 'countDistinctAccountsFromIp'
  | 'claimWebhookEvent'
  | 'getWebhookEvent'
  | 'completeWebhookEvent'
  | 'releaseWebhookEvent'
  | 'claimWebhookBodyHash'
  | 'webhookBodyProvider'
  | 'pingDb'
  | 'failStaleRunningRuns'
  | 'heartbeatReviewRun'
  | 'interruptReviewRun'
  | 'pruneEphemeralData'
>;
