import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export interface SqliteConnectionOptions {
  checkoutRoot: string;
  requireDurableStorage: boolean;
}

export type SqliteConnection = Database.Database;

export function assertDurableStorePath(dbPath: string, options: SqliteConnectionOptions): void {
  if (!options.requireDurableStorage) return;

  const resolvedDbPath = path.resolve(dbPath);
  const checkoutRoot = path.resolve(options.checkoutRoot);
  const relativeToCheckout = path.relative(checkoutRoot, resolvedDbPath);
  const insideCheckout =
    relativeToCheckout === '' ||
    (!relativeToCheckout.startsWith(`..${path.sep}`) &&
      relativeToCheckout !== '..' &&
      !path.isAbsolute(relativeToCheckout));

  if (
    !path.isAbsolute(dbPath) ||
    insideCheckout ||
    dbPath.includes(`${path.sep}.data${path.sep}`)
  ) {
    throw new Error(
      `durable production STORE_PATH must be an absolute path outside the checkout: ${dbPath}`,
    );
  }
}

export function openSqliteConnection(
  dbPath: string,
  options: SqliteConnectionOptions,
): SqliteConnection {
  assertDurableStorePath(dbPath, options);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  // Multi-process writers wait briefly on SQLITE_BUSY instead of failing a
  // quota or lock update immediately.
  db.pragma('busy_timeout = 5000');
  return db;
}
