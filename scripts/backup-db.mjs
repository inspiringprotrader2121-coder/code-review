#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('../packages/store/node_modules/better-sqlite3');

const dbPath = process.env.STORE_PATH ?? '/home/orvex/orvex-data/velatrix-review.db';
const backupDir = process.env.ORVEX_BACKUP_DIR ?? '/home/orvex/orvex-backups';
const remote = process.env.ORVEX_BACKUP_REMOTE;
const requireRemote = process.env.ORVEX_REQUIRE_OFFSITE_BACKUP === '1';
const retentionDays = Number(process.env.ORVEX_BACKUP_RETENTION_DAYS ?? 14);

if (!fs.existsSync(dbPath)) {
  throw new Error(`database does not exist: ${dbPath}`);
}
if (!Number.isFinite(retentionDays) || retentionDays < 1 || retentionDays > 365) {
  throw new Error('ORVEX_BACKUP_RETENTION_DAYS must be between 1 and 365');
}
fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
const stamp = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}-${process.pid}-${process.hrtime.bigint().toString().slice(-6)}`;
const destination = path.join(backupDir, `velatrix-review-${stamp}.db`);
const temporary = `${destination}.tmp`;

const source = new Database(dbPath, { readonly: true, fileMustExist: true });
let promoted = false;
try {
  try {
    await source.backup(temporary);
  } finally {
    source.close();
  }

  fs.chmodSync(temporary, 0o600);
  const verification = new Database(temporary, { readonly: true, fileMustExist: true });
  try {
    const integrity = verification.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') throw new Error(`SQLite integrity check failed: ${String(integrity)}`);
  } finally {
    verification.close();
  }
  fs.renameSync(temporary, destination);
  promoted = true;
} finally {
  if (!promoted) fs.rmSync(temporary, { force: true });
}

try {
  if (remote) {
    execFileSync('rsync', ['-a', '--chmod=F600', destination, remote], { stdio: 'inherit' });
  } else if (requireRemote) {
    // Keep the local snapshot even when the off-site destination is not
    // configured. The cron invocation must still fail loudly for monitoring, but
    // a missing business setting must never erase the only working backup path.
    console.error(`local backup created at ${destination}, but ORVEX_BACKUP_REMOTE is not configured`);
    throw new Error('off-site backup was required but no remote was configured');
  }
} finally {
  // Retention is local hygiene and must run even when off-site delivery fails;
  // otherwise a broken remote silently turns every scheduled backup into a
  // permanent disk allocation.
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  for (const entry of fs.readdirSync(backupDir, { withFileTypes: true })) {
    if (!entry.isFile() || !/^velatrix-review-.*\.db$/.test(entry.name)) continue;
    const file = path.join(backupDir, entry.name);
    if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file);
  }
}

console.log(`database backup created: ${destination}`);
