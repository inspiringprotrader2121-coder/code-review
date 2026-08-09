import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const require = createRequire(import.meta.url);
const Database = require('../packages/store/node_modules/better-sqlite3');

function createFixture(file, { brokenForeignKey = false } = {}) {
  const db = new Database(file);
  try {
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE tenants (id TEXT PRIMARY KEY);
      CREATE TABLE github_installations (
        id INTEGER PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id)
      );
      CREATE TABLE review_runs (id TEXT PRIMARY KEY);
      CREATE TABLE users (id TEXT PRIMARY KEY);
      CREATE TABLE sessions (id TEXT PRIMARY KEY);
    `);
    db.prepare('INSERT INTO tenants (id) VALUES (?)').run('tenant-1');
    db.prepare('INSERT INTO github_installations (id, tenant_id) VALUES (?, ?)').run(1, 'tenant-1');
    if (brokenForeignKey) {
      db.pragma('foreign_keys = OFF');
      db.prepare('INSERT INTO github_installations (id, tenant_id) VALUES (?, ?)').run(
        2,
        'missing',
      );
    }
  } finally {
    db.close();
  }
}

test('restore drill accepts the current github_installations schema', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-restore-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'valid.db');
  createFixture(file);
  const result = spawnSync(process.execPath, ['scripts/restore-db-drill.mjs', file], {
    cwd: path.resolve('.'),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /restore drill passed/);
});

test('restore drill rejects foreign-key corruption', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-restore-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'broken.db');
  createFixture(file, { brokenForeignKey: true });
  const result = spawnSync(process.execPath, ['scripts/restore-db-drill.mjs', file], {
    cwd: path.resolve('.'),
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /foreign-key check failed/);
});
