import type { SqliteConnection } from '../../connection.js';
import type { PrKey } from '../../types.js';

export class SqliteReviewStatisticsRepository {
  constructor(private readonly db: SqliteConnection) {}

  countRecentFixRuns(key: PrKey, sinceMs = 86_400_000): number {
    return this.countForPr(
      key,
      `action LIKE 'fix:%' AND status = 'completed'`,
      new Date(Date.now() - sinceMs).toISOString(),
    );
  }

  countRecentSkippedRuns(key: PrKey, skipReason: string, sinceMs: number): number {
    const since = new Date(Date.now() - sinceMs).toISOString();
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM review_runs WHERE installation_id = ? AND owner = ? AND repo = ? AND pr = ?
       AND status = 'skipped' AND skip_reason = ? AND created_at >= ?`,
        )
        .get(key.installationId, key.owner, key.repo, key.pr, skipReason, since) as { n: number }
    ).n;
  }

  countRecentFailedRuns(key: PrKey, sinceMs = 30 * 60_000): number {
    return this.countForPr(key, `status = 'failed'`, new Date(Date.now() - sinceMs).toISOString());
  }

  countGlobalFreeTierReviewsSince(sinceMs: number): number {
    const since = new Date(Date.now() - sinceMs).toISOString();
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM review_runs WHERE free_tier = 1
       AND (status IN ('running', 'completed', 'failed') OR (status = 'skipped' AND skip_reason LIKE 'interrupted by restart%'))
       AND action NOT LIKE 'fix:%' AND action NOT LIKE 'cmd:%' AND action NOT LIKE 'scan:%' AND created_at >= ?`,
        )
        .get(since) as { n: number }
    ).n;
  }

  private countForPr(key: PrKey, predicate: string, since: string): number {
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM review_runs WHERE installation_id = ? AND owner = ? AND repo = ? AND pr = ?
       AND ${predicate} AND created_at >= ?`,
        )
        .get(key.installationId, key.owner, key.repo, key.pr, since) as { n: number }
    ).n;
  }
}
