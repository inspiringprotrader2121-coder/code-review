import type { SqliteConnection } from '../connection.js';
import type { Repo } from '../types.js';

/** Installation-scoped repository lookup contract. */
export interface RepositoryReadStore {
  getByGitHubId(installationId: number, githubRepoId: number): Repo | null;
  getByFullName(installationId: number, fullName: string): Repo | null;
  listForTenant(tenantId: string): Repo[];
  hasEnabledRepo(fullName: string): boolean;
}

export class RepositoryReadRepository implements RepositoryReadStore {
  constructor(private readonly db: SqliteConnection) {}

  getByGitHubId(installationId: number, githubRepoId: number): Repo | null {
    const row = this.db
      .prepare(`SELECT * FROM repos WHERE installation_id = ? AND github_repo_id = ?`)
      .get(installationId, githubRepoId) as RepoRow | undefined;
    return row ? mapRepo(row) : null;
  }

  getByFullName(installationId: number, fullName: string): Repo | null {
    const row = this.db
      .prepare(`SELECT * FROM repos WHERE installation_id = ? AND lower(full_name) = lower(?)`)
      .get(installationId, fullName) as RepoRow | undefined;
    return row ? mapRepo(row) : null;
  }

  listForTenant(tenantId: string): Repo[] {
    const rows = this.db
      .prepare(`SELECT * FROM repos WHERE tenant_id = ? ORDER BY full_name`)
      .all(tenantId) as RepoRow[];
    return rows.map(mapRepo);
  }

  hasEnabledRepo(fullName: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS ok FROM repos WHERE lower(full_name) = lower(?) AND enabled = 1 LIMIT 1`,
      )
      .get(fullName) as { ok: number } | undefined;
    return Boolean(row);
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
  review_on_open: number;
  review_on_push: number;
  added_at: string;
  updated_at: string;
}

function mapRepo(row: RepoRow): Repo {
  return {
    id: row.id,
    installationId: row.installation_id,
    tenantId: row.tenant_id,
    githubRepoId: row.github_repo_id,
    owner: row.owner,
    name: row.name,
    fullName: row.full_name,
    private: Boolean(row.private),
    defaultBranch: row.default_branch ?? undefined,
    enabled: Boolean(row.enabled),
    reviewMode: row.review_mode === 'strict' ? 'strict' : 'normal',
    autoApply: Boolean(row.auto_apply),
    reviewOnOpen: Boolean(row.review_on_open ?? 1),
    reviewOnPush: Boolean(row.review_on_push ?? 1),
    addedAt: row.added_at,
    updatedAt: row.updated_at,
  };
}
