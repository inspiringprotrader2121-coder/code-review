import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { PrKey, PrReviewState, StoredFinding } from './types.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pr_reviews (
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  pr INTEGER NOT NULL,
  last_sha TEXT NOT NULL,
  findings_json TEXT NOT NULL,
  last_review_at TEXT NOT NULL,
  last_summary_comment_id INTEGER,
  PRIMARY KEY (owner, repo, pr)
);
`;

export class SqliteReviewStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
  }

  getState(key: PrKey): PrReviewState | null {
    const row = this.db
      .prepare(
        `SELECT last_sha, findings_json, last_review_at, last_summary_comment_id
         FROM pr_reviews WHERE owner = ? AND repo = ? AND pr = ?`,
      )
      .get(key.owner, key.repo, key.pr) as
      | {
          last_sha: string;
          findings_json: string;
          last_review_at: string;
          last_summary_comment_id: number | null;
        }
      | undefined;

    if (!row) return null;

    return {
      owner: key.owner,
      repo: key.repo,
      pr: key.pr,
      lastSha: row.last_sha,
      findings: JSON.parse(row.findings_json) as StoredFinding[],
      lastReviewAt: row.last_review_at,
      lastSummaryCommentId: row.last_summary_comment_id ?? undefined,
    };
  }

  saveState(state: PrReviewState): void {
    this.db
      .prepare(
        `INSERT INTO pr_reviews (owner, repo, pr, last_sha, findings_json, last_review_at, last_summary_comment_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(owner, repo, pr) DO UPDATE SET
           last_sha = excluded.last_sha,
           findings_json = excluded.findings_json,
           last_review_at = excluded.last_review_at,
           last_summary_comment_id = excluded.last_summary_comment_id`,
      )
      .run(
        state.owner,
        state.repo,
        state.pr,
        state.lastSha,
        JSON.stringify(state.findings),
        state.lastReviewAt,
        state.lastSummaryCommentId ?? null,
      );
  }

  close(): void {
    this.db.close();
  }
}

export function createReviewStore(): SqliteReviewStore {
  const dbPath = process.env.STORE_PATH ?? path.join(process.cwd(), '.data', 'reviews.db');
  return new SqliteReviewStore(dbPath);
}
