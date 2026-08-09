import type { SqliteConnection } from '../connection.js';
import { STORE_MIGRATIONS, validateMigrationLedger, type MigrationLedgerRow } from './artifacts.js';
import { repairLegacyAttemptLineageReferences } from './compatibility.js';
import { findMigrationStep } from './steps.js';

export function runStoreMigrations(db: SqliteConnection): void {
  db.exec(`CREATE TABLE IF NOT EXISTS orvex_schema_migrations (
    version INTEGER PRIMARY KEY CHECK (version > 0), name TEXT NOT NULL UNIQUE,
    checksum TEXT NOT NULL, artifact_timestamp TEXT, applied_at TEXT NOT NULL
  )`);
  const ledgerColumns = db.prepare(`PRAGMA table_info(orvex_schema_migrations)`).all() as Array<{
    name: string;
  }>;
  if (!ledgerColumns.some((column) => column.name === 'artifact_timestamp'))
    db.exec(`ALTER TABLE orvex_schema_migrations ADD COLUMN artifact_timestamp TEXT`);

  const applied = db
    .prepare(
      `SELECT version, name, checksum, artifact_timestamp FROM orvex_schema_migrations ORDER BY version ASC`,
    )
    .all() as MigrationLedgerRow[];
  validateMigrationLedger(applied);
  for (let index = applied.length; index < STORE_MIGRATIONS.length; index += 1) {
    const migration = STORE_MIGRATIONS[index]!;
    const step = findMigrationStep(migration.version);
    db.transaction(() => {
      if (migration.version === 14) repairLegacyAttemptLineageReferences(db);
      step.apply(db);
      db.prepare(
        `INSERT INTO orvex_schema_migrations (version, name, checksum, artifact_timestamp, applied_at)
        VALUES (?, ?, ?, ?, ?)`,
      ).run(
        migration.version,
        migration.name,
        migration.checksum,
        migration.timestamp,
        new Date().toISOString(),
      );
    })();
  }
}
