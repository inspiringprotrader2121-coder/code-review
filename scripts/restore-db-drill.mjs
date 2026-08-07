#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('../packages/store/node_modules/better-sqlite3');

const backup = process.env.ORVEX_BACKUP_FILE ?? process.argv[2];
if (!backup) throw new Error('usage: ORVEX_BACKUP_FILE=/path/backup.db node scripts/restore-db-drill.mjs');
if (!fs.existsSync(backup)) throw new Error(`backup does not exist: ${backup}`);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-restore-drill-'));
const restored = path.join(dir, 'restored.db');
try {
  fs.copyFileSync(backup, restored);
  fs.chmodSync(restored, 0o600);
  const db = new Database(restored, { readonly: true, fileMustExist: true });
  try {
    const integrity = db.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') throw new Error(`SQLite integrity check failed: ${String(integrity)}`);
    const required = ['tenants', 'installations', 'review_runs', 'users', 'sessions'];
    const present = new Set(
      db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all().map((r) => r.name),
    );
    const missing = required.filter((name) => !present.has(name));
    if (missing.length > 0) {
      throw new Error(`restore drill missing core tables: ${missing.join(', ')}`);
    }
    const tables = present.size;
    console.log(`restore drill passed: ${tables} table(s) readable from ${backup}`);
  } finally {
    db.close();
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
