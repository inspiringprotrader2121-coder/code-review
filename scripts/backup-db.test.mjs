import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const Database = require('../packages/store/node_modules/better-sqlite3');

test('backup-db creates an integrity-checked SQLite snapshot and prunes old files', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-backup-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const dbPath = path.join(dir, 'source.db');
  const backupDir = path.join(dir, 'backups');
  const source = new Database(dbPath);
  source.exec("CREATE TABLE marker (value TEXT NOT NULL); INSERT INTO marker VALUES ('kept');");
  source.close();

  const result = spawnSync(process.execPath, ['scripts/backup-db.mjs'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      STORE_PATH: dbPath,
      ORVEX_BACKUP_DIR: backupDir,
      ORVEX_BACKUP_RETENTION_DAYS: '14',
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);

  const files = fs.readdirSync(backupDir).filter((file) => file.endsWith('.db'));
  assert.equal(files.length, 1);
  const backup = new Database(path.join(backupDir, files[0]), { readonly: true });
  assert.equal(backup.prepare('SELECT value FROM marker').get().value, 'kept');
  assert.equal(fs.statSync(path.join(backupDir, files[0])).mode & 0o777, 0o600);
  backup.close();

  const stale = path.join(backupDir, 'velatrix-review-stale.db');
  fs.writeFileSync(stale, 'old');
  fs.utimesSync(stale, new Date(0), new Date(0));
  const second = spawnSync(process.execPath, ['scripts/backup-db.mjs'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      STORE_PATH: dbPath,
      ORVEX_BACKUP_DIR: backupDir,
      ORVEX_BACKUP_RETENTION_DAYS: '1',
    },
    encoding: 'utf8',
  });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(fs.existsSync(stale), false);
});

test('missing off-site configuration does not discard the local backup', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-backup-offsite-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, 'source.db');
  const backupDir = path.join(dir, 'backups');
  const source = new Database(dbPath);
  source.exec('CREATE TABLE marker (value TEXT NOT NULL);');
  source.close();

  const result = spawnSync(process.execPath, ['scripts/backup-db.mjs'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      STORE_PATH: dbPath,
      ORVEX_BACKUP_DIR: backupDir,
      ORVEX_REQUIRE_OFFSITE_BACKUP: '1',
      ORVEX_BACKUP_REMOTE: '',
    },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.equal(fs.readdirSync(backupDir).filter((file) => file.endsWith('.db')).length, 1);
});
