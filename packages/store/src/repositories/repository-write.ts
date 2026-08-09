import { randomUUID } from 'node:crypto';
import type { SqliteConnection } from '../connection.js';
import type { PullRequestState, Repo, WorkspaceSettings } from '../types.js';

export interface RepositoryWriteLookups {
  getRepoByGitHubId(installationId: number, githubRepoId: number): Repo | null;
  getRepoByFullName(installationId: number, fullName: string): Repo | null;
  getWorkspaceSettings(tenantId: string): WorkspaceSettings;
}

/** Mutable repository, PR, scheduler-target, and workspace-settings persistence. */
export class SqliteRepositoryWriteRepository {
  constructor(
    private readonly db: SqliteConnection,
    private readonly lookups: RepositoryWriteLookups,
  ) {}

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
    const existing = this.lookups.getRepoByGitHubId(input.installationId, input.githubRepoId);
    // preserve an operator's explicit enable/disable choice across resyncs
    const enabled = existing ? existing.enabled : (input.enabled ?? true);
    this.db
      .prepare(
        `INSERT INTO repos
       (id, installation_id, tenant_id, github_repo_id, owner, name, full_name, private,
        default_branch, enabled, review_mode, auto_apply, added_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'normal', 0, ?, ?)
       ON CONFLICT(installation_id, github_repo_id) DO UPDATE SET
         tenant_id = excluded.tenant_id,
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
    return this.lookups.getRepoByGitHubId(input.installationId, input.githubRepoId)!;
  }

  listScanTargets(): Array<{
    installationId: number;
    tenantId: string;
    owner: string;
    name: string;
    fullName: string;
    defaultBranch: string | null;
    plan: string;
  }> {
    const rows = this.db
      .prepare(
        `SELECT r.installation_id AS installationId, r.tenant_id AS tenantId, r.owner AS owner,
              r.name AS name, r.full_name AS fullName, r.default_branch AS defaultBranch, t.plan AS plan
       FROM repos r
       JOIN tenants t ON t.id = r.tenant_id
       JOIN github_installations gi ON gi.installation_id = r.installation_id
       WHERE r.enabled = 1 AND gi.suspended_at IS NULL`,
      )
      .all() as Array<{
      installationId: number;
      tenantId: string;
      owner: string;
      name: string;
      fullName: string;
      defaultBranch: string | null;
      plan: string;
    }>;
    return rows;
  }

  setRepoEnabled(repoId: string, enabled: boolean): void {
    this.db
      .prepare(`UPDATE repos SET enabled = ?, updated_at = ? WHERE id = ?`)
      .run(enabled ? 1 : 0, new Date().toISOString(), repoId);
  }

  /** Disable a repository when GitHub removes it from the installation. */

  disableRepoByGitHubId(installationId: number, githubRepoId: number): boolean {
    const result = this.db
      .prepare(
        `UPDATE repos SET enabled = 0, updated_at = ? WHERE installation_id = ? AND github_repo_id = ?`,
      )
      .run(new Date().toISOString(), installationId, githubRepoId);
    return result.changes > 0;
  }

  /** Disable all repository automations when an installation is deleted. */

  disableReposForInstallation(installationId: number): number {
    return this.db
      .prepare(
        `UPDATE repos SET enabled = 0, updated_at = ? WHERE installation_id = ? AND enabled = 1`,
      )
      .run(new Date().toISOString(), installationId).changes;
  }

  updateRepoSettings(
    repoId: string,
    patch: {
      reviewMode?: 'normal' | 'strict';
      autoApply?: boolean;
      reviewOnOpen?: boolean;
      reviewOnPush?: boolean;
    },
  ): void {
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
    if (patch.reviewOnOpen !== undefined) {
      sets.push('review_on_open = ?');
      vals.push(patch.reviewOnOpen ? 1 : 0);
    }
    if (patch.reviewOnPush !== undefined) {
      sets.push('review_on_push = ?');
      vals.push(patch.reviewOnPush ? 1 : 0);
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
    const repo = this.lookups.getRepoByFullName(installationId, fullName);
    return repo ? repo.enabled : true;
  }

  /**
   * Whether Orvex should auto-review THIS specific trigger — the dashboard
   * settings-section toggles. `opened`/`reopened`/`ready_for_review` are gated
   * by reviewOnOpen; `synchronize` (a new push to an open PR) by reviewOnPush.
   * An unknown repo defaults to true for both (same "on before the dashboard is
   * visited" reasoning as isRepoEnabled) so a fresh install isn't silently inert.
   */

  isRepoActionEnabled(installationId: number, fullName: string, action: string): boolean {
    const repo = this.lookups.getRepoByFullName(installationId, fullName);
    if (!repo) return true;
    if (action === 'synchronize') return repo.reviewOnPush;
    return repo.reviewOnOpen; // opened, reopened, ready_for_review
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
         tenant_id = excluded.tenant_id,
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

  markReviewedNow(
    installationId: number,
    repoFullName: string,
    prNumber: number,
    openFindings: number,
  ): void {
    this.db
      .prepare(
        `UPDATE pull_requests SET last_reviewed_at = ?, open_findings = ?, updated_at = ?
       WHERE installation_id = ? AND repo_full_name = ? AND number = ?`,
      )
      .run(
        new Date().toISOString(),
        openFindings,
        new Date().toISOString(),
        installationId,
        repoFullName,
        prNumber,
      );
  }

  updateWorkspaceSettings(
    tenantId: string,
    patch: Partial<Omit<WorkspaceSettings, 'tenantId' | 'updatedAt'>>,
  ): WorkspaceSettings {
    const current = this.lookups.getWorkspaceSettings(tenantId);
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
    return this.lookups.getWorkspaceSettings(tenantId);
  }
}

export type RepositoryWriteRepository = Pick<
  SqliteRepositoryWriteRepository,
  | 'upsertRepo'
  | 'listScanTargets'
  | 'setRepoEnabled'
  | 'disableRepoByGitHubId'
  | 'disableReposForInstallation'
  | 'updateRepoSettings'
  | 'isRepoEnabled'
  | 'isRepoActionEnabled'
  | 'upsertPullRequest'
  | 'markReviewedNow'
  | 'updateWorkspaceSettings'
>;
