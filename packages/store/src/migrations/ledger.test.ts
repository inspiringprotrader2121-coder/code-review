import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { AppDatabase } from '../database.js';
import {
  STORE_MIGRATIONS,
  canonicalExecutableArtifact,
  defineExecutableMigration,
} from './artifacts.js';
import { BASELINE_SCHEMA_V2 } from './baseline.js';
import { STORE_MIGRATION_STEPS } from './steps.js';

type RawDatabase = {
  prepare: (sql: string) => { run: (...values: unknown[]) => unknown; all: () => unknown[] };
  pragma: (value: string, options?: { simple?: boolean }) => unknown;
};

function raw(database: AppDatabase): RawDatabase {
  return (database as unknown as { db: RawDatabase }).db;
}

test('executable migration artifacts are immutable, ordered, and distinct from frozen ledger history', () => {
  assert.equal(STORE_MIGRATION_STEPS.length, STORE_MIGRATIONS.length);
  assert.deepEqual(
    STORE_MIGRATION_STEPS.map((step) => step.version),
    STORE_MIGRATIONS.map((migration) => migration.version),
  );
  for (const step of STORE_MIGRATION_STEPS) {
    assert.ok(Object.isFrozen(step));
    assert.ok(Object.isFrozen(step.artifact));
  }
  assert.equal(STORE_MIGRATION_STEPS[0]?.artifact.sql, BASELINE_SCHEMA_V2);

  const first = defineExecutableMigration({
    version: 18,
    timestamp: '2026-08-09T00:00:01.000Z',
    name: 'example',
    artifact: { format: 'sqlite-sql-v1', sql: 'CREATE TABLE example (id TEXT PRIMARY KEY);' },
  });
  const changed = defineExecutableMigration({
    version: 18,
    timestamp: '2026-08-09T00:00:01.000Z',
    name: 'example',
    artifact: {
      format: 'sqlite-sql-v1',
      sql: 'CREATE TABLE example (id TEXT PRIMARY KEY, value TEXT);',
    },
  });
  assert.notEqual(first.checksum, changed.checksum);
  assert.equal(
    first.artifact,
    canonicalExecutableArtifact({
      format: 'sqlite-sql-v1',
      sql: 'CREATE TABLE example (id TEXT PRIMARY KEY);',
    }),
  );
  assert.equal(STORE_MIGRATIONS[0]?.name, 'baseline-schema-v2');
});

test('each v1-v17 historical ledger boundary upgrades without reinterpreting applied rows', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'orvex-store-ledger-fixtures-'));
  try {
    for (let boundary = 0; boundary <= STORE_MIGRATIONS.length; boundary += 1) {
      const dbPath = path.join(directory, `v${boundary}.db`);
      const original = new AppDatabase(dbPath, `fixture-${boundary}`);
      const connection = raw(original);
      connection.prepare(`DELETE FROM orvex_schema_migrations WHERE version > ?`).run(boundary);
      if (boundary < 15) {
        for (const migration of STORE_MIGRATIONS.filter(
          (candidate) => candidate.version <= boundary && candidate.version < 15,
        )) {
          connection
            .prepare(
              `UPDATE orvex_schema_migrations SET checksum = ?, artifact_timestamp = NULL WHERE version = ?`,
            )
            .run(migration.legacyChecksums[0], migration.version);
        }
      }
      original.close();

      const upgraded = new AppDatabase(dbPath, `upgrade-${boundary}`);
      const ledger = raw(upgraded)
        .prepare(
          `SELECT version, name, checksum, artifact_timestamp FROM orvex_schema_migrations ORDER BY version`,
        )
        .all() as Array<{
        version: number;
        name: string;
        checksum: string;
        artifact_timestamp: string | null;
      }>;
      assert.deepEqual(
        ledger,
        STORE_MIGRATIONS.map(({ version, name, checksum, timestamp }) => ({
          version,
          name,
          checksum,
          artifact_timestamp: timestamp,
        })),
        `v${boundary} ledger`,
      );
      assert.equal(raw(upgraded).pragma('integrity_check', { simple: true }), 'ok');
      assert.deepEqual(raw(upgraded).prepare('PRAGMA foreign_key_check').all(), []);
      upgraded.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('ledger validation rejects checksum mutation rather than reinterpreting deployed history', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'orvex-store-ledger-integrity-'));
  try {
    const dbPath = path.join(directory, 'store.db');
    const database = new AppDatabase(dbPath);
    raw(database)
      .prepare(`UPDATE orvex_schema_migrations SET checksum = 'mutated' WHERE version = 17`)
      .run();
    database.close();
    assert.throws(() => new AppDatabase(dbPath), /schema migration ledger checksum mismatch/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
