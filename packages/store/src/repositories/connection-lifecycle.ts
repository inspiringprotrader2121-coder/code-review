import type { SqliteConnection } from '../connection.js';

/** Owns explicit connection shutdown for the compatibility facade. */
export class SqliteConnectionLifecycleRepository {
  constructor(private readonly db: SqliteConnection) {}

  close(): void {
    this.db.close();
  }
}

export type ConnectionLifecycleRepository = Pick<SqliteConnectionLifecycleRepository, 'close'>;
