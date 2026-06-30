import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type {
  GitHubInstallation,
  PrKey,
  PrReviewState,
  Tenant,
} from './types.js';

const SCHEMA_V2 = `
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS github_installations (
  installation_id INTEGER PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  account_login TEXT NOT NULL,
  account_type TEXT NOT NULL,
  repository_selection TEXT NOT NULL DEFAULT 'selected',
  suspended_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_installations_tenant ON github_installations(tenant_id);

CREATE TABLE IF NOT EXISTS pr_reviews (
  installation_id INTEGER NOT NULL,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  pr INTEGER NOT NULL,
  tenant_id TEXT NOT NULL,
  last_sha TEXT NOT NULL,
  findings_json TEXT NOT NULL,
  last_review_at TEXT NOT NULL,
  last_summary_comment_id INTEGER,
  PRIMARY KEY (installation_id, owner, repo, pr)
);
`;

export class AppDatabase {
  private db: Database.Database;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA_V2);
    this.migrateLegacyPrReviews();
  }

  private migrateLegacyPrReviews(): void {
    const cols = this.db.prepare(`PRAGMA table_info(pr_reviews)`).all() as Array<{ name: string }>;
    if (cols.length === 0) return;
    if (cols.some((c) => c.name === 'installation_id')) return;

    this.db.exec(`
      ALTER TABLE pr_reviews RENAME TO pr_reviews_legacy;
      CREATE TABLE pr_reviews (
        installation_id INTEGER NOT NULL,
        owner TEXT NOT NULL,
        repo TEXT NOT NULL,
        pr INTEGER NOT NULL,
        tenant_id TEXT NOT NULL DEFAULT 'legacy',
        last_sha TEXT NOT NULL,
        findings_json TEXT NOT NULL,
        last_review_at TEXT NOT NULL,
        last_summary_comment_id INTEGER,
        PRIMARY KEY (installation_id, owner, repo, pr)
      );
      DROP TABLE pr_reviews_legacy;
    `);
  }

  // ——— Tenants ———

  createTenant(slug: string, name?: string): Tenant {
    const id = randomUUID();
    const now = new Date().toISOString();
    const normalized = slug.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    this.db
      .prepare(`INSERT INTO tenants (id, slug, name, created_at) VALUES (?, ?, ?, ?)`)
      .run(id, normalized, name ?? normalized, now);
    return { id, slug: normalized, name: name ?? normalized, createdAt: now };
  }

  getTenantBySlug(slug: string): Tenant | null {
    const row = this.db
      .prepare(`SELECT id, slug, name, created_at FROM tenants WHERE slug = ?`)
      .get(slug.toLowerCase()) as
      | { id: string; slug: string; name: string; created_at: string }
      | undefined;
    if (!row) return null;
    return { id: row.id, slug: row.slug, name: row.name, createdAt: row.created_at };
  }

  getOrCreateTenant(slug: string, name?: string): Tenant {
    return this.getTenantBySlug(slug) ?? this.createTenant(slug, name);
  }

  getTenantById(id: string): Tenant | null {
    const row = this.db
      .prepare(`SELECT id, slug, name, created_at FROM tenants WHERE id = ?`)
      .get(id) as { id: string; slug: string; name: string; created_at: string } | undefined;
    if (!row) return null;
    return { id: row.id, slug: row.slug, name: row.name, createdAt: row.created_at };
  }

  // ——— Installations ———

  upsertInstallation(input: {
    installationId: number;
    tenantId: string;
    accountLogin: string;
    accountType: string;
    repositorySelection?: string;
    suspendedAt?: string | null;
  }): GitHubInstallation {
    const now = new Date().toISOString();
    const existing = this.getInstallation(input.installationId);
    const createdAt = existing?.createdAt ?? now;

    this.db
      .prepare(
        `INSERT INTO github_installations
         (installation_id, tenant_id, account_login, account_type, repository_selection, suspended_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(installation_id) DO UPDATE SET
           tenant_id = excluded.tenant_id,
           account_login = excluded.account_login,
           account_type = excluded.account_type,
           repository_selection = excluded.repository_selection,
           suspended_at = excluded.suspended_at,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.installationId,
        input.tenantId,
        input.accountLogin,
        input.accountType,
        input.repositorySelection ?? 'selected',
        input.suspendedAt ?? null,
        createdAt,
        now,
      );

    return this.getInstallation(input.installationId)!;
  }

  getInstallation(installationId: number): GitHubInstallation | null {
    const row = this.db
      .prepare(
        `SELECT installation_id, tenant_id, account_login, account_type, repository_selection,
                suspended_at, created_at, updated_at
         FROM github_installations WHERE installation_id = ?`,
      )
      .get(installationId) as
      | {
          installation_id: number;
          tenant_id: string;
          account_login: string;
          account_type: string;
          repository_selection: string;
          suspended_at: string | null;
          created_at: string;
          updated_at: string;
        }
      | undefined;

    if (!row) return null;
    return {
      installationId: row.installation_id,
      tenantId: row.tenant_id,
      accountLogin: row.account_login,
      accountType: row.account_type,
      repositorySelection: row.repository_selection,
      suspendedAt: row.suspended_at ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  getInstallationsForTenant(tenantId: string): GitHubInstallation[] {
    const rows = this.db
      .prepare(
        `SELECT installation_id, tenant_id, account_login, account_type, repository_selection,
                suspended_at, created_at, updated_at
         FROM github_installations WHERE tenant_id = ? ORDER BY updated_at DESC`,
      )
      .all(tenantId) as Array<{
        installation_id: number;
        tenant_id: string;
        account_login: string;
        account_type: string;
        repository_selection: string;
        suspended_at: string | null;
        created_at: string;
        updated_at: string;
      }>;

    return rows.map((row) => ({
      installationId: row.installation_id,
      tenantId: row.tenant_id,
      accountLogin: row.account_login,
      accountType: row.account_type,
      repositorySelection: row.repository_selection,
      suspendedAt: row.suspended_at ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  findInstallationForRepo(owner: string, repo: string): GitHubInstallation | null {
    const slug = `${owner}/${repo}`.toLowerCase();
    const rows = this.db
      .prepare(`SELECT installation_id FROM github_installations WHERE suspended_at IS NULL`)
      .all() as Array<{ installation_id: number }>;

    for (const row of rows) {
      const inst = this.getInstallation(row.installation_id);
      if (inst && inst.accountLogin.toLowerCase() === owner.toLowerCase()) {
        return inst;
      }
    }

    const bySlug = this.db
      .prepare(
        `SELECT gi.installation_id FROM github_installations gi
         JOIN tenants t ON t.id = gi.tenant_id
         WHERE lower(gi.account_login) = lower(?) AND gi.suspended_at IS NULL
         LIMIT 1`,
      )
      .get(owner) as { installation_id: number } | undefined;

    if (bySlug) return this.getInstallation(bySlug.installation_id);

    void slug;
    return null;
  }

  // ——— PR review state ———

  getState(key: PrKey): PrReviewState | null {
    const row = this.db
      .prepare(
        `SELECT tenant_id, last_sha, findings_json, last_review_at, last_summary_comment_id
         FROM pr_reviews
         WHERE installation_id = ? AND owner = ? AND repo = ? AND pr = ?`,
      )
      .get(key.installationId, key.owner, key.repo, key.pr) as
      | {
          tenant_id: string;
          last_sha: string;
          findings_json: string;
          last_review_at: string;
          last_summary_comment_id: number | null;
        }
      | undefined;

    if (!row) return null;

    return {
      installationId: key.installationId,
      tenantId: row.tenant_id,
      owner: key.owner,
      repo: key.repo,
      pr: key.pr,
      lastSha: row.last_sha,
      findings: JSON.parse(row.findings_json),
      lastReviewAt: row.last_review_at,
      lastSummaryCommentId: row.last_summary_comment_id ?? undefined,
    };
  }

  saveState(state: PrReviewState): void {
    this.db
      .prepare(
        `INSERT INTO pr_reviews
         (installation_id, owner, repo, pr, tenant_id, last_sha, findings_json, last_review_at, last_summary_comment_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(installation_id, owner, repo, pr) DO UPDATE SET
           tenant_id = excluded.tenant_id,
           last_sha = excluded.last_sha,
           findings_json = excluded.findings_json,
           last_review_at = excluded.last_review_at,
           last_summary_comment_id = excluded.last_summary_comment_id`,
      )
      .run(
        state.installationId,
        state.owner,
        state.repo,
        state.pr,
        state.tenantId,
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

let sharedDb: AppDatabase | null = null;

export function createAppDatabase(): AppDatabase {
  if (!sharedDb) {
    const dbPath = process.env.STORE_PATH ?? path.join(process.cwd(), '.data', 'velatrix-review.db');
    sharedDb = new AppDatabase(dbPath);
  }
  return sharedDb;
}

/** @deprecated use createAppDatabase */
export function createReviewStore(): AppDatabase {
  return createAppDatabase();
}

export type SqliteReviewStore = AppDatabase;
