import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type {
  FindingRecord,
  FindingStatus,
  GitHubInstallation,
  PrKey,
  PrReviewState,
  PrSettings,
  PullRequest,
  PullRequestState,
  Repo,
  ReviewRun,
  ReviewRunStatus,
  Session,
  StoredFinding,
  Tenant,
  User,
  WorkspaceMember,
  WorkspaceRole,
  WorkspaceSettings,
  WorkspaceStats,
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

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  github_id INTEGER NOT NULL UNIQUE,
  login TEXT NOT NULL,
  name TEXT,
  avatar_url TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS workspace_members (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL DEFAULT 'member',
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_members_user ON workspace_members(user_id);

CREATE TABLE IF NOT EXISTS review_runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  installation_id INTEGER NOT NULL,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  pr INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT NOT NULL,
  skip_reason TEXT,
  error TEXT,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  findings_new INTEGER NOT NULL DEFAULT 0,
  findings_fixed INTEGER NOT NULL DEFAULT 0,
  findings_open INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_runs_tenant_time ON review_runs(tenant_id, created_at);

CREATE TABLE IF NOT EXISTS pr_settings (
  installation_id INTEGER NOT NULL,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  pr INTEGER NOT NULL,
  auto_apply INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (installation_id, owner, repo, pr)
);

CREATE TABLE IF NOT EXISTS fix_locks (
  installation_id INTEGER NOT NULL,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  pr INTEGER NOT NULL,
  holder TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  PRIMARY KEY (installation_id, owner, repo, pr)
);

CREATE TABLE IF NOT EXISTS finding_suppressions (
  installation_id INTEGER NOT NULL,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  rule_id TEXT,
  suppressed_by TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (installation_id, owner, repo, fingerprint)
);

CREATE TABLE IF NOT EXISTS repos (
  id TEXT PRIMARY KEY,
  installation_id INTEGER NOT NULL,
  tenant_id TEXT NOT NULL,
  github_repo_id INTEGER NOT NULL,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  full_name TEXT NOT NULL,
  private INTEGER NOT NULL DEFAULT 0,
  default_branch TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  review_mode TEXT NOT NULL DEFAULT 'normal',
  auto_apply INTEGER NOT NULL DEFAULT 0,
  added_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (installation_id, github_repo_id)
);

CREATE INDEX IF NOT EXISTS idx_repos_tenant ON repos(tenant_id);

CREATE TABLE IF NOT EXISTS pull_requests (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  installation_id INTEGER NOT NULL,
  repo_full_name TEXT NOT NULL,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  author TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open',
  draft INTEGER NOT NULL DEFAULT 0,
  head_sha TEXT NOT NULL,
  url TEXT,
  open_findings INTEGER NOT NULL DEFAULT 0,
  opened_at TEXT,
  closed_at TEXT,
  merged_at TEXT,
  last_reviewed_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (installation_id, repo_full_name, number)
);

CREATE INDEX IF NOT EXISTS idx_pulls_tenant_state ON pull_requests(tenant_id, state);

CREATE TABLE IF NOT EXISTS findings (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  installation_id INTEGER NOT NULL,
  repo_full_name TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  file TEXT NOT NULL,
  line INTEGER,
  severity TEXT NOT NULL,
  category TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  rule_id TEXT NOT NULL,
  github_comment_id INTEGER,
  first_seen_sha TEXT NOT NULL,
  fixed_at_sha TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (installation_id, repo_full_name, pr_number, fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_findings_tenant_status ON findings(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_findings_pr ON findings(installation_id, repo_full_name, pr_number);

CREATE TABLE IF NOT EXISTS workspace_settings (
  tenant_id TEXT PRIMARY KEY,
  default_review_mode TEXT NOT NULL DEFAULT 'normal',
  auto_apply_default INTEGER NOT NULL DEFAULT 0,
  min_confidence REAL NOT NULL DEFAULT 0.6,
  max_comments INTEGER NOT NULL DEFAULT 8,
  auto_enable_new_repos INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
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

  /**
   * Slug of the most "active" tenant for the legacy dashboard's default view:
   * the one with the most tracked repos, then the one with a live installation,
   * then the earliest created. Avoids landing on an empty demo workspace.
   */
  firstTenantSlug(): string | null {
    const row = this.db
      .prepare(
        `SELECT t.slug,
                (SELECT COUNT(*) FROM repos r WHERE r.tenant_id = t.id) AS repo_count,
                (SELECT COUNT(*) FROM github_installations gi WHERE gi.tenant_id = t.id AND gi.suspended_at IS NULL) AS inst_count
         FROM tenants t
         ORDER BY inst_count DESC, repo_count DESC, t.created_at ASC
         LIMIT 1`,
      )
      .get() as { slug: string } | undefined;
    return row?.slug ?? null;
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

    // keep the dashboard findings projection in sync with the operational blob
    this.projectFindings(
      {
        tenantId: state.tenantId,
        installationId: state.installationId,
        owner: state.owner,
        repo: state.repo,
        pr: state.pr,
      },
      state.findings,
    );
  }

  // ——— Users & sessions ———

  upsertUserFromGitHub(input: {
    githubId: number;
    login: string;
    name?: string | null;
    avatarUrl?: string | null;
  }): User {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO users (id, github_id, login, name, avatar_url, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(github_id) DO UPDATE SET
           login = excluded.login,
           name = excluded.name,
           avatar_url = excluded.avatar_url`,
      )
      .run(randomUUID(), input.githubId, input.login, input.name ?? null, input.avatarUrl ?? null, now);
    return this.getUserByGitHubId(input.githubId)!;
  }

  getUserByGitHubId(githubId: number): User | null {
    const row = this.db
      .prepare(`SELECT * FROM users WHERE github_id = ?`)
      .get(githubId) as UserRow | undefined;
    return row ? mapUser(row) : null;
  }

  getUserById(id: string): User | null {
    const row = this.db.prepare(`SELECT * FROM users WHERE id = ?`).get(id) as UserRow | undefined;
    return row ? mapUser(row) : null;
  }

  createSession(userId: string, ttlMs = 30 * 24 * 3_600_000): Session {
    const id = randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
    this.db
      .prepare(`INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)`)
      .run(id, userId, expiresAt, now.toISOString());
    return { id, userId, expiresAt, createdAt: now.toISOString() };
  }

  getSessionUser(sessionId: string): User | null {
    const row = this.db
      .prepare(`SELECT user_id, expires_at FROM sessions WHERE id = ?`)
      .get(sessionId) as { user_id: string; expires_at: string } | undefined;
    if (!row) return null;
    if (new Date(row.expires_at).getTime() < Date.now()) {
      this.deleteSession(sessionId);
      return null;
    }
    return this.getUserById(row.user_id);
  }

  deleteSession(sessionId: string): void {
    this.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sessionId);
  }

  // ——— Workspace membership ———

  addWorkspaceMember(tenantId: string, userId: string, role: WorkspaceRole): WorkspaceMember {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO workspace_members (tenant_id, user_id, role, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(tenant_id, user_id) DO UPDATE SET role = excluded.role`,
      )
      .run(tenantId, userId, role, now);
    return { tenantId, userId, role, createdAt: now };
  }

  getMembership(tenantId: string, userId: string): WorkspaceMember | null {
    const row = this.db
      .prepare(`SELECT * FROM workspace_members WHERE tenant_id = ? AND user_id = ?`)
      .get(tenantId, userId) as
      | { tenant_id: string; user_id: string; role: string; created_at: string }
      | undefined;
    if (!row) return null;
    return {
      tenantId: row.tenant_id,
      userId: row.user_id,
      role: row.role as WorkspaceRole,
      createdAt: row.created_at,
    };
  }

  getWorkspacesForUser(userId: string): Array<{ tenant: Tenant; role: WorkspaceRole }> {
    const rows = this.db
      .prepare(
        `SELECT t.id, t.slug, t.name, t.created_at, m.role
         FROM workspace_members m JOIN tenants t ON t.id = m.tenant_id
         WHERE m.user_id = ? ORDER BY t.created_at`,
      )
      .all(userId) as Array<{ id: string; slug: string; name: string; created_at: string; role: string }>;
    return rows.map((r) => ({
      tenant: { id: r.id, slug: r.slug, name: r.name, createdAt: r.created_at },
      role: r.role as WorkspaceRole,
    }));
  }

  /** True if the tenant has no members yet (pre-auth workspace or freshly created). */
  tenantHasMembers(tenantId: string): boolean {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM workspace_members WHERE tenant_id = ?`)
      .get(tenantId) as { n: number };
    return row.n > 0;
  }

  // ——— PR settings (auto-apply) ———

  getPrSettings(key: PrKey): PrSettings {
    const row = this.db
      .prepare(
        `SELECT auto_apply, updated_at FROM pr_settings
         WHERE installation_id = ? AND owner = ? AND repo = ? AND pr = ?`,
      )
      .get(key.installationId, key.owner, key.repo, key.pr) as
      | { auto_apply: number; updated_at: string }
      | undefined;
    return {
      installationId: key.installationId,
      owner: key.owner,
      repo: key.repo,
      pr: key.pr,
      autoApply: Boolean(row?.auto_apply),
      updatedAt: row?.updated_at ?? new Date().toISOString(),
    };
  }

  setPrAutoApply(key: PrKey, enabled: boolean): void {
    this.db
      .prepare(
        `INSERT INTO pr_settings (installation_id, owner, repo, pr, auto_apply, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(installation_id, owner, repo, pr) DO UPDATE SET
           auto_apply = excluded.auto_apply,
           updated_at = excluded.updated_at`,
      )
      .run(key.installationId, key.owner, key.repo, key.pr, enabled ? 1 : 0, new Date().toISOString());
  }

  // ——— Fix locks (one fix operation per PR at a time) ———

  acquireFixLock(key: PrKey, holder: string, staleMs = 300_000): boolean {
    const now = Date.now();
    const row = this.db
      .prepare(
        `SELECT holder, acquired_at FROM fix_locks
         WHERE installation_id = ? AND owner = ? AND repo = ? AND pr = ?`,
      )
      .get(key.installationId, key.owner, key.repo, key.pr) as
      | { holder: string; acquired_at: string }
      | undefined;

    if (row && now - new Date(row.acquired_at).getTime() < staleMs) {
      return false;
    }

    this.db
      .prepare(
        `INSERT INTO fix_locks (installation_id, owner, repo, pr, holder, acquired_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(installation_id, owner, repo, pr) DO UPDATE SET
           holder = excluded.holder,
           acquired_at = excluded.acquired_at`,
      )
      .run(key.installationId, key.owner, key.repo, key.pr, holder, new Date(now).toISOString());
    return true;
  }

  releaseFixLock(key: PrKey, holder: string): void {
    this.db
      .prepare(
        `DELETE FROM fix_locks
         WHERE installation_id = ? AND owner = ? AND repo = ? AND pr = ? AND holder = ?`,
      )
      .run(key.installationId, key.owner, key.repo, key.pr, holder);
  }

  // ——— Finding suppressions (@orvex ignore) ———

  addSuppression(input: {
    installationId: number;
    owner: string;
    repo: string;
    fingerprint: string;
    ruleId?: string;
    suppressedBy?: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO finding_suppressions
         (installation_id, owner, repo, fingerprint, rule_id, suppressed_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(installation_id, owner, repo, fingerprint) DO NOTHING`,
      )
      .run(
        input.installationId,
        input.owner,
        input.repo,
        input.fingerprint,
        input.ruleId ?? null,
        input.suppressedBy ?? null,
        new Date().toISOString(),
      );
  }

  getSuppressedFingerprints(installationId: number, owner: string, repo: string): Set<string> {
    const rows = this.db
      .prepare(
        `SELECT fingerprint FROM finding_suppressions
         WHERE installation_id = ? AND owner = ? AND repo = ?`,
      )
      .all(installationId, owner, repo) as Array<{ fingerprint: string }>;
    return new Set(rows.map((r) => r.fingerprint));
  }

  /** Fix commits on this PR in the last `sinceMs` — the runaway-loop guard. */
  countRecentFixRuns(key: PrKey, sinceMs = 86_400_000): number {
    const since = new Date(Date.now() - sinceMs).toISOString();
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM review_runs
         WHERE installation_id = ? AND owner = ? AND repo = ? AND pr = ?
           AND action LIKE 'fix:%' AND status = 'completed' AND created_at >= ?`,
      )
      .get(key.installationId, key.owner, key.repo, key.pr, since) as { n: number };
    return row.n;
  }

  // ——— Review runs (usage metrics) ———

  recordReviewRun(input: {
    tenantId: string;
    installationId: number;
    owner: string;
    repo: string;
    pr: number;
    headSha: string;
    action: string;
    status: ReviewRunStatus;
    skipReason?: string;
    error?: string;
    durationMs: number;
    findingsNew?: number;
    findingsFixed?: number;
    findingsOpen?: number;
  }): ReviewRun {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO review_runs
         (id, tenant_id, installation_id, owner, repo, pr, head_sha, action, status,
          skip_reason, error, duration_ms, findings_new, findings_fixed, findings_open, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.tenantId,
        input.installationId,
        input.owner,
        input.repo,
        input.pr,
        input.headSha,
        input.action,
        input.status,
        input.skipReason ?? null,
        input.error ?? null,
        input.durationMs,
        input.findingsNew ?? 0,
        input.findingsFixed ?? 0,
        input.findingsOpen ?? 0,
        now,
      );
    return {
      id,
      tenantId: input.tenantId,
      installationId: input.installationId,
      owner: input.owner,
      repo: input.repo,
      pr: input.pr,
      headSha: input.headSha,
      action: input.action,
      status: input.status,
      skipReason: input.skipReason,
      error: input.error,
      durationMs: input.durationMs,
      findingsNew: input.findingsNew ?? 0,
      findingsFixed: input.findingsFixed ?? 0,
      findingsOpen: input.findingsOpen ?? 0,
      createdAt: now,
    };
  }

  listReviewRuns(tenantId: string, limit = 50): ReviewRun[] {
    const rows = this.db
      .prepare(`SELECT * FROM review_runs WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?`)
      .all(tenantId, limit) as ReviewRunRow[];
    return rows.map(mapReviewRun);
  }

  getWorkspaceStats(tenantId: string, sinceDays = 14): WorkspaceStats {
    const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString();
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*) AS runs_total,
           SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS runs_completed,
           SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS runs_skipped,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS runs_failed,
           SUM(findings_new) AS findings_new,
           SUM(findings_fixed) AS findings_fixed,
           AVG(CASE WHEN status = 'completed' THEN duration_ms END) AS avg_duration_ms
         FROM review_runs WHERE tenant_id = ? AND created_at >= ?`,
      )
      .get(tenantId, since) as {
        runs_total: number;
        runs_completed: number | null;
        runs_skipped: number | null;
        runs_failed: number | null;
        findings_new: number | null;
        findings_fixed: number | null;
        avg_duration_ms: number | null;
      };
    return {
      sinceDays,
      runsTotal: row.runs_total,
      runsCompleted: row.runs_completed ?? 0,
      runsSkipped: row.runs_skipped ?? 0,
      runsFailed: row.runs_failed ?? 0,
      findingsNew: row.findings_new ?? 0,
      findingsFixed: row.findings_fixed ?? 0,
      avgDurationMs: row.avg_duration_ms,
    };
  }

  // ——— Repos (selectable / enable-toggle) ———

  upsertRepo(input: {
    installationId: number;
    tenantId: string;
    githubRepoId: number;
    owner: string;
    name: string;
    fullName: string;
    private?: boolean;
    defaultBranch?: string;
    enabled?: boolean;
  }): Repo {
    const now = new Date().toISOString();
    const existing = this.getRepoByGitHubId(input.installationId, input.githubRepoId);
    // preserve an operator's explicit enable/disable choice across resyncs
    const enabled = existing ? existing.enabled : (input.enabled ?? true);
    this.db
      .prepare(
        `INSERT INTO repos
         (id, installation_id, tenant_id, github_repo_id, owner, name, full_name, private,
          default_branch, enabled, review_mode, auto_apply, added_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'normal', 0, ?, ?)
         ON CONFLICT(installation_id, github_repo_id) DO UPDATE SET
           owner = excluded.owner, name = excluded.name, full_name = excluded.full_name,
           private = excluded.private, default_branch = excluded.default_branch,
           updated_at = excluded.updated_at`,
      )
      .run(
        existing?.id ?? randomUUID(),
        input.installationId,
        input.tenantId,
        input.githubRepoId,
        input.owner,
        input.name,
        input.fullName,
        input.private ? 1 : 0,
        input.defaultBranch ?? null,
        enabled ? 1 : 0,
        existing?.addedAt ?? now,
        now,
      );
    return this.getRepoByGitHubId(input.installationId, input.githubRepoId)!;
  }

  getRepoByGitHubId(installationId: number, githubRepoId: number): Repo | null {
    const row = this.db
      .prepare(`SELECT * FROM repos WHERE installation_id = ? AND github_repo_id = ?`)
      .get(installationId, githubRepoId) as RepoRow | undefined;
    return row ? mapRepo(row) : null;
  }

  getRepoByFullName(installationId: number, fullName: string): Repo | null {
    const row = this.db
      .prepare(`SELECT * FROM repos WHERE installation_id = ? AND lower(full_name) = lower(?)`)
      .get(installationId, fullName) as RepoRow | undefined;
    return row ? mapRepo(row) : null;
  }

  listRepos(tenantId: string): Repo[] {
    const rows = this.db
      .prepare(`SELECT * FROM repos WHERE tenant_id = ? ORDER BY full_name`)
      .all(tenantId) as RepoRow[];
    return rows.map(mapRepo);
  }

  setRepoEnabled(repoId: string, enabled: boolean): void {
    this.db
      .prepare(`UPDATE repos SET enabled = ?, updated_at = ? WHERE id = ?`)
      .run(enabled ? 1 : 0, new Date().toISOString(), repoId);
  }

  updateRepoSettings(repoId: string, patch: { reviewMode?: 'normal' | 'strict'; autoApply?: boolean }): void {
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (patch.reviewMode) {
      sets.push('review_mode = ?');
      vals.push(patch.reviewMode);
    }
    if (patch.autoApply !== undefined) {
      sets.push('auto_apply = ?');
      vals.push(patch.autoApply ? 1 : 0);
    }
    if (sets.length === 0) return;
    sets.push('updated_at = ?');
    vals.push(new Date().toISOString(), repoId);
    this.db.prepare(`UPDATE repos SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  /**
   * Whether Orvex should review this repo. Unknown repos default to enabled
   * (honoring the workspace's auto_enable_new_repos), so reviews work before a
   * user visits the dashboard; explicit disables are always respected.
   */
  isRepoEnabled(installationId: number, fullName: string): boolean {
    const repo = this.getRepoByFullName(installationId, fullName);
    return repo ? repo.enabled : true;
  }

  // ——— Pull request lifecycle ———

  upsertPullRequest(input: {
    tenantId: string;
    installationId: number;
    repoFullName: string;
    number: number;
    title: string;
    author: string;
    state: PullRequestState;
    draft?: boolean;
    headSha: string;
    url?: string;
    openedAt?: string;
    closedAt?: string;
    mergedAt?: string;
  }): void {
    const now = new Date().toISOString();
    const existingId = (
      this.db
        .prepare(
          `SELECT id FROM pull_requests WHERE installation_id = ? AND repo_full_name = ? AND number = ?`,
        )
        .get(input.installationId, input.repoFullName, input.number) as { id: string } | undefined
    )?.id;
    this.db
      .prepare(
        `INSERT INTO pull_requests
         (id, tenant_id, installation_id, repo_full_name, number, title, author, state, draft,
          head_sha, url, opened_at, closed_at, merged_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(installation_id, repo_full_name, number) DO UPDATE SET
           title = excluded.title, author = excluded.author, state = excluded.state,
           draft = excluded.draft, head_sha = excluded.head_sha, url = excluded.url,
           closed_at = excluded.closed_at, merged_at = excluded.merged_at,
           updated_at = excluded.updated_at`,
      )
      .run(
        existingId ?? randomUUID(),
        input.tenantId,
        input.installationId,
        input.repoFullName,
        input.number,
        input.title,
        input.author,
        input.state,
        input.draft ? 1 : 0,
        input.headSha,
        input.url ?? null,
        input.openedAt ?? now,
        input.closedAt ?? null,
        input.mergedAt ?? null,
        now,
      );
  }

  markReviewedNow(installationId: number, repoFullName: string, prNumber: number, openFindings: number): void {
    this.db
      .prepare(
        `UPDATE pull_requests SET last_reviewed_at = ?, open_findings = ?, updated_at = ?
         WHERE installation_id = ? AND repo_full_name = ? AND number = ?`,
      )
      .run(new Date().toISOString(), openFindings, new Date().toISOString(), installationId, repoFullName, prNumber);
  }

  listPullRequests(tenantId: string, opts: { state?: PullRequestState; limit?: number } = {}): PullRequest[] {
    const limit = opts.limit ?? 100;
    const rows = opts.state
      ? (this.db
          .prepare(`SELECT * FROM pull_requests WHERE tenant_id = ? AND state = ? ORDER BY updated_at DESC LIMIT ?`)
          .all(tenantId, opts.state, limit) as PullRequestRow[])
      : (this.db
          .prepare(`SELECT * FROM pull_requests WHERE tenant_id = ? ORDER BY updated_at DESC LIMIT ?`)
          .all(tenantId, limit) as PullRequestRow[]);
    return rows.map(mapPullRequest);
  }

  getPullRequestCounts(tenantId: string): { open: number; merged: number; closed: number } {
    const rows = this.db
      .prepare(`SELECT state, COUNT(*) AS n FROM pull_requests WHERE tenant_id = ? GROUP BY state`)
      .all(tenantId) as Array<{ state: string; n: number }>;
    const counts = { open: 0, merged: 0, closed: 0 };
    for (const r of rows) if (r.state in counts) counts[r.state as keyof typeof counts] = r.n;
    return counts;
  }

  // ——— Findings projection (dashboard bug list) ———

  /** Replace the projected findings for one PR (called on every saveState). */
  projectFindings(
    key: { tenantId: string; installationId: number; owner: string; repo: string; pr: number },
    findings: StoredFinding[],
  ): void {
    const fullName = `${key.owner}/${key.repo}`;
    const now = new Date().toISOString();
    const tx = this.db.transaction(() => {
      this.db
        .prepare(`DELETE FROM findings WHERE installation_id = ? AND repo_full_name = ? AND pr_number = ?`)
        .run(key.installationId, fullName, key.pr);
      const insert = this.db.prepare(
        `INSERT INTO findings
         (id, tenant_id, installation_id, repo_full_name, pr_number, fingerprint, file, line,
          severity, category, message, status, rule_id, github_comment_id, first_seen_sha,
          fixed_at_sha, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const f of findings) {
        insert.run(
          randomUUID(),
          key.tenantId,
          key.installationId,
          fullName,
          key.pr,
          f.fingerprint,
          f.file,
          f.line ?? null,
          f.severity,
          f.category,
          f.message,
          f.status,
          f.ruleId,
          f.githubCommentId ?? null,
          f.firstSeenSha,
          f.fixedAtSha ?? null,
          now,
          now,
        );
      }
    });
    tx();
  }

  listFindings(
    tenantId: string,
    opts: { status?: FindingStatus; repoFullName?: string; limit?: number } = {},
  ): FindingRecord[] {
    const clauses = ['tenant_id = ?'];
    const vals: unknown[] = [tenantId];
    if (opts.status) {
      clauses.push('status = ?');
      vals.push(opts.status);
    }
    if (opts.repoFullName) {
      clauses.push('lower(repo_full_name) = lower(?)');
      vals.push(opts.repoFullName);
    }
    vals.push(opts.limit ?? 200);
    const rows = this.db
      .prepare(
        `SELECT * FROM findings WHERE ${clauses.join(' AND ')}
         ORDER BY CASE severity WHEN 'P1' THEN 0 WHEN 'P2' THEN 1 WHEN 'P3' THEN 2 ELSE 3 END,
                  updated_at DESC LIMIT ?`,
      )
      .all(...vals) as FindingRow[];
    return rows.map(mapFinding);
  }

  getFindingCounts(tenantId: string): { open: number; fixed: number; ignored: number; bySeverity: Record<string, number> } {
    const statusRows = this.db
      .prepare(`SELECT status, COUNT(*) AS n FROM findings WHERE tenant_id = ? GROUP BY status`)
      .all(tenantId) as Array<{ status: string; n: number }>;
    const sevRows = this.db
      .prepare(`SELECT severity, COUNT(*) AS n FROM findings WHERE tenant_id = ? AND status = 'open' GROUP BY severity`)
      .all(tenantId) as Array<{ severity: string; n: number }>;
    const counts = { open: 0, fixed: 0, ignored: 0, bySeverity: {} as Record<string, number> };
    for (const r of statusRows) {
      if (r.status === 'open' || r.status === 'fixed' || r.status === 'ignored') counts[r.status] = r.n;
    }
    for (const r of sevRows) counts.bySeverity[r.severity] = r.n;
    return counts;
  }

  // ——— Workspace settings ———

  getWorkspaceSettings(tenantId: string): WorkspaceSettings {
    const row = this.db
      .prepare(`SELECT * FROM workspace_settings WHERE tenant_id = ?`)
      .get(tenantId) as WorkspaceSettingsRow | undefined;
    if (!row) {
      return {
        tenantId,
        defaultReviewMode: 'normal',
        autoApplyDefault: false,
        minConfidence: 0.6,
        maxComments: 8,
        autoEnableNewRepos: true,
        updatedAt: new Date().toISOString(),
      };
    }
    return mapWorkspaceSettings(row);
  }

  updateWorkspaceSettings(tenantId: string, patch: Partial<Omit<WorkspaceSettings, 'tenantId' | 'updatedAt'>>): WorkspaceSettings {
    const current = this.getWorkspaceSettings(tenantId);
    const next = { ...current, ...patch };
    this.db
      .prepare(
        `INSERT INTO workspace_settings
         (tenant_id, default_review_mode, auto_apply_default, min_confidence, max_comments, auto_enable_new_repos, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id) DO UPDATE SET
           default_review_mode = excluded.default_review_mode,
           auto_apply_default = excluded.auto_apply_default,
           min_confidence = excluded.min_confidence,
           max_comments = excluded.max_comments,
           auto_enable_new_repos = excluded.auto_enable_new_repos,
           updated_at = excluded.updated_at`,
      )
      .run(
        tenantId,
        next.defaultReviewMode,
        next.autoApplyDefault ? 1 : 0,
        next.minConfidence,
        next.maxComments,
        next.autoEnableNewRepos ? 1 : 0,
        new Date().toISOString(),
      );
    return this.getWorkspaceSettings(tenantId);
  }

  close(): void {
    this.db.close();
  }
}

interface RepoRow {
  id: string;
  installation_id: number;
  tenant_id: string;
  github_repo_id: number;
  owner: string;
  name: string;
  full_name: string;
  private: number;
  default_branch: string | null;
  enabled: number;
  review_mode: string;
  auto_apply: number;
  added_at: string;
  updated_at: string;
}

function mapRepo(r: RepoRow): Repo {
  return {
    id: r.id,
    installationId: r.installation_id,
    tenantId: r.tenant_id,
    githubRepoId: r.github_repo_id,
    owner: r.owner,
    name: r.name,
    fullName: r.full_name,
    private: Boolean(r.private),
    defaultBranch: r.default_branch ?? undefined,
    enabled: Boolean(r.enabled),
    reviewMode: r.review_mode === 'strict' ? 'strict' : 'normal',
    autoApply: Boolean(r.auto_apply),
    addedAt: r.added_at,
    updatedAt: r.updated_at,
  };
}

interface PullRequestRow {
  id: string;
  tenant_id: string;
  installation_id: number;
  repo_full_name: string;
  number: number;
  title: string;
  author: string;
  state: string;
  draft: number;
  head_sha: string;
  url: string | null;
  open_findings: number;
  opened_at: string | null;
  closed_at: string | null;
  merged_at: string | null;
  last_reviewed_at: string | null;
  updated_at: string;
}

function mapPullRequest(r: PullRequestRow): PullRequest {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    installationId: r.installation_id,
    repoFullName: r.repo_full_name,
    number: r.number,
    title: r.title,
    author: r.author,
    state: r.state as PullRequestState,
    draft: Boolean(r.draft),
    headSha: r.head_sha,
    url: r.url ?? undefined,
    openFindings: r.open_findings,
    openedAt: r.opened_at ?? undefined,
    closedAt: r.closed_at ?? undefined,
    mergedAt: r.merged_at ?? undefined,
    lastReviewedAt: r.last_reviewed_at ?? undefined,
    updatedAt: r.updated_at,
  };
}

interface FindingRow {
  id: string;
  tenant_id: string;
  installation_id: number;
  repo_full_name: string;
  pr_number: number;
  fingerprint: string;
  file: string;
  line: number | null;
  severity: string;
  category: string;
  message: string;
  status: string;
  rule_id: string;
  github_comment_id: number | null;
  first_seen_sha: string;
  fixed_at_sha: string | null;
  created_at: string;
  updated_at: string;
}

function mapFinding(r: FindingRow): FindingRecord {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    installationId: r.installation_id,
    repoFullName: r.repo_full_name,
    prNumber: r.pr_number,
    fingerprint: r.fingerprint,
    file: r.file,
    line: r.line ?? undefined,
    severity: r.severity,
    category: r.category,
    message: r.message,
    status: r.status as FindingStatus,
    ruleId: r.rule_id,
    githubCommentId: r.github_comment_id ?? undefined,
    firstSeenSha: r.first_seen_sha,
    fixedAtSha: r.fixed_at_sha ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

interface WorkspaceSettingsRow {
  tenant_id: string;
  default_review_mode: string;
  auto_apply_default: number;
  min_confidence: number;
  max_comments: number;
  auto_enable_new_repos: number;
  updated_at: string;
}

function mapWorkspaceSettings(r: WorkspaceSettingsRow): WorkspaceSettings {
  return {
    tenantId: r.tenant_id,
    defaultReviewMode: r.default_review_mode === 'strict' ? 'strict' : 'normal',
    autoApplyDefault: Boolean(r.auto_apply_default),
    minConfidence: r.min_confidence,
    maxComments: r.max_comments,
    autoEnableNewRepos: Boolean(r.auto_enable_new_repos),
    updatedAt: r.updated_at,
  };
}

interface UserRow {
  id: string;
  github_id: number;
  login: string;
  name: string | null;
  avatar_url: string | null;
  created_at: string;
}

function mapUser(row: UserRow): User {
  return {
    id: row.id,
    githubId: row.github_id,
    login: row.login,
    name: row.name ?? undefined,
    avatarUrl: row.avatar_url ?? undefined,
    createdAt: row.created_at,
  };
}

interface ReviewRunRow {
  id: string;
  tenant_id: string;
  installation_id: number;
  owner: string;
  repo: string;
  pr: number;
  head_sha: string;
  action: string;
  status: string;
  skip_reason: string | null;
  error: string | null;
  duration_ms: number;
  findings_new: number;
  findings_fixed: number;
  findings_open: number;
  created_at: string;
}

function mapReviewRun(row: ReviewRunRow): ReviewRun {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    installationId: row.installation_id,
    owner: row.owner,
    repo: row.repo,
    pr: row.pr,
    headSha: row.head_sha,
    action: row.action,
    status: row.status as ReviewRunStatus,
    skipReason: row.skip_reason ?? undefined,
    error: row.error ?? undefined,
    durationMs: row.duration_ms,
    findingsNew: row.findings_new,
    findingsFixed: row.findings_fixed,
    findingsOpen: row.findings_open,
    createdAt: row.created_at,
  };
}

let sharedDb: AppDatabase | null = null;

export function createAppDatabase(): AppDatabase {
  if (!sharedDb) {
    sharedDb = new AppDatabase(process.env.STORE_PATH ?? defaultDbPath());
  }
  return sharedDb;
}

function defaultDbPath(): string {
  const dataDir = path.join(process.cwd(), '.data');
  const legacy = path.join(dataDir, 'velatrix-review.db');
  const current = path.join(dataDir, 'orvex-review.db');
  // keep using a pre-rename database if it's the only one present
  if (!fs.existsSync(current) && fs.existsSync(legacy)) return legacy;
  return current;
}

/** @deprecated use createAppDatabase */
export function createReviewStore(): AppDatabase {
  return createAppDatabase();
}

export type SqliteReviewStore = AppDatabase;
