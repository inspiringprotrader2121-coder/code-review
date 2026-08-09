import type { BillingConnection } from './shared.js';
import { CHARGEABLE_REVIEW_WHERE } from './shared.js';

/** Read-only quota, rate-limit, and per-run overage calculations. */
export class SqliteReviewUsageRepository {
  constructor(private readonly db: BillingConnection) {}

  countAccountReviews(owner: string, opts: { sinceMs?: number } = {}): number {
    const params: unknown[] = [owner];
    let where = `lower(owner) = lower(?) AND (status IN ('running', 'completed', 'failed') OR (status = 'skipped' AND skip_reason LIKE 'interrupted by restart%')) AND ${CHARGEABLE_REVIEW_WHERE}`;
    if (opts.sinceMs !== undefined) {
      where += ' AND created_at >= ?';
      params.push(new Date(Date.now() - opts.sinceMs).toISOString());
    }
    return (
      this.db.prepare(`SELECT COUNT(*) AS n FROM review_runs WHERE ${where}`).get(...params) as {
        n: number;
      }
    ).n;
  }

  countRunningAccountReviews(owner: string, sinceMs = 30 * 24 * 3_600_000): number {
    return this.countRunningReviewsByOwner(owner, sinceMs, `AND ${CHARGEABLE_REVIEW_WHERE}`);
  }

  countRunningCogsReservations(owner: string, sinceMs = 30 * 24 * 3_600_000): number {
    return this.countRunningReviewsByOwner(owner, sinceMs, '');
  }

  countTenantReviewUnits(
    tenantId: string,
    opts: { sinceMs?: number; sinceIso?: string } = {},
  ): number {
    const params: unknown[] = [tenantId];
    let where = `tenant_id = ? AND (status IN ('running', 'completed', 'failed') OR (status = 'skipped' AND skip_reason LIKE 'interrupted by restart%')) AND ${CHARGEABLE_REVIEW_WHERE}`;
    if (opts.sinceIso !== undefined) {
      where += ' AND created_at >= ?';
      params.push(opts.sinceIso);
    } else if (opts.sinceMs !== undefined) {
      where += ' AND created_at >= ?';
      params.push(new Date(Date.now() - opts.sinceMs).toISOString());
    }
    return (
      Number(
        (
          this.db
            .prepare(
              `SELECT COALESCE(SUM(CASE WHEN deep = 1 THEN 2 ELSE 1 END), 0) AS n FROM review_runs WHERE ${where}`,
            )
            .get(...params) as { n: number }
        ).n,
      ) || 0
    );
  }

  oldestAccountReviewCreatedAt(owner: string, sinceMs: number): string | null {
    const row = this.db
      .prepare(
        `SELECT created_at FROM review_runs
       WHERE lower(owner) = lower(?) AND (status IN ('running', 'completed', 'failed') OR (status = 'skipped' AND skip_reason LIKE 'interrupted by restart%'))
         AND ${CHARGEABLE_REVIEW_WHERE} AND created_at >= ?
       ORDER BY created_at ASC LIMIT 1`,
      )
      .get(owner, new Date(Date.now() - sinceMs).toISOString()) as
      | { created_at: string }
      | undefined;
    return row?.created_at ?? null;
  }

  countTenantCompletedReviewsSince(tenantId: string, sinceIso: string): number {
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM review_runs
       WHERE tenant_id = ? AND status = 'completed' AND ${CHARGEABLE_REVIEW_WHERE} AND created_at >= ?`,
        )
        .get(tenantId, sinceIso) as { n: number }
    ).n;
  }

  completedReviewUnitsSince(tenantId: string, sinceIso: string): number {
    return (
      this.db
        .prepare(
          `SELECT COALESCE(SUM(CASE WHEN deep = 1 THEN 2 ELSE 1 END), 0) AS n FROM review_runs
       WHERE tenant_id = ? AND status = 'completed' AND ${CHARGEABLE_REVIEW_WHERE} AND created_at >= ?`,
        )
        .get(tenantId, sinceIso) as { n: number }
    ).n;
  }

  reviewRunOverageUnits(
    tenantId: string,
    runId: string,
    sinceIso: string,
  ): { unitsBefore: number; unitsThrough: number } | null {
    const row = this.db
      .prepare(
        `WITH target AS (
         SELECT id, created_at FROM review_runs WHERE id = ? AND tenant_id = ?
       )
       SELECT
         COALESCE((
           SELECT SUM(CASE WHEN r.deep = 1 THEN 2 ELSE 1 END) FROM review_runs r, target t
           WHERE r.tenant_id = ? AND r.status = 'completed' AND ${CHARGEABLE_REVIEW_WHERE} AND r.created_at >= ?
             AND (r.created_at < t.created_at OR (r.created_at = t.created_at AND r.id < t.id))
         ), 0) AS units_before,
         COALESCE((
           SELECT SUM(CASE WHEN r.deep = 1 THEN 2 ELSE 1 END) FROM review_runs r, target t
           WHERE r.tenant_id = ? AND r.status = 'completed' AND ${CHARGEABLE_REVIEW_WHERE} AND r.created_at >= ?
             AND (r.created_at < t.created_at OR (r.created_at = t.created_at AND r.id <= t.id))
         ), 0) AS units_through
       FROM target`,
      )
      .get(runId, tenantId, tenantId, sinceIso, tenantId, sinceIso) as
      | { units_before: number; units_through: number }
      | undefined;
    return row ? { unitsBefore: row.units_before, unitsThrough: row.units_through } : null;
  }

  countAccountCommandRuns(owner: string, sinceMs = 3_600_000): number {
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM review_runs
       WHERE lower(owner) = lower(?) AND action LIKE 'cmd:%'
         AND status IN ('running', 'completed') AND created_at >= ?`,
        )
        .get(owner, new Date(Date.now() - sinceMs).toISOString()) as { n: number }
    ).n;
  }

  secondsSinceLastCompletedReview(
    installationId: number,
    owner: string,
    repo: string,
    pr: number,
    headSha: string,
  ): number | null {
    const row = this.db
      .prepare(
        `SELECT created_at FROM review_runs
       WHERE installation_id = ? AND owner = ? AND repo = ? AND pr = ? AND head_sha = ?
         AND status = 'completed' AND action NOT LIKE 'fix:%' AND action NOT LIKE 'scan:%'
       ORDER BY created_at DESC LIMIT 1`,
      )
      .get(installationId, owner, repo, pr, headSha) as { created_at: string } | undefined;
    return row ? Math.floor((Date.now() - new Date(row.created_at).getTime()) / 1000) : null;
  }

  sumAccountCost(
    owner: string,
    sinceMs = 30 * 24 * 3_600_000,
  ): { costUsd: number; reviews: number } {
    const row = this.db
      .prepare(
        `WITH account_runs AS (
         SELECT id, cost_usd FROM review_runs WHERE lower(owner) = lower(?) AND created_at >= ?
       ), run_costs AS (
         SELECT u.run_id, SUM(u.cost_usd) AS cost FROM review_run_usage u
         INNER JOIN account_runs r ON r.id = u.run_id GROUP BY u.run_id
       )
       SELECT COALESCE(SUM(CASE WHEN rc.run_id IS NULL THEN r.cost_usd ELSE rc.cost END), 0) AS cost,
              COUNT(*) AS n
       FROM account_runs r LEFT JOIN run_costs rc ON rc.run_id = r.id
       WHERE r.cost_usd > 0 OR rc.run_id IS NOT NULL`,
      )
      .get(owner, new Date(Date.now() - sinceMs).toISOString()) as { cost: number; n: number };
    return { costUsd: row.cost, reviews: row.n };
  }

  private countRunningReviewsByOwner(owner: string, sinceMs: number, extraWhere: string): number {
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM review_runs
       WHERE lower(owner) = lower(?) AND status = 'running' AND created_at >= ? ${extraWhere}`,
        )
        .get(owner, new Date(Date.now() - sinceMs).toISOString()) as { n: number }
    ).n;
  }
}
