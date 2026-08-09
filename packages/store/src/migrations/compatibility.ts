import type { SqliteConnection } from '../connection.js';

/**
 * One-time repair for rows written before durable attempt lineage existed.
 * It preserves usage while clearing relationships that cannot be proven, and
 * runs atomically with migration 14 before its integrity triggers are added.
 */
export function repairLegacyAttemptLineageReferences(db: SqliteConnection): void {
  db.exec(`
UPDATE review_run_usage SET attempt_id = NULL
WHERE attempt_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM review_run_attempts attempt
  WHERE attempt.id = review_run_usage.attempt_id
    AND attempt.run_id = review_run_usage.run_id
    AND attempt.tenant_id = review_run_usage.tenant_id
);
UPDATE review_run_attempts SET parent_attempt_id = NULL
WHERE parent_attempt_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM review_run_attempts parent
  WHERE parent.id = review_run_attempts.parent_attempt_id
    AND parent.run_id = review_run_attempts.run_id
    AND parent.tenant_id = review_run_attempts.tenant_id
);`);
}
