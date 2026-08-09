import type { GitHubAppConfig } from '@orvex-review/github';
import { listInstallationRepos } from '@orvex-review/github';
import type {
  RepositoryWriteRepository,
  Tenant,
  TenancyRepository,
  WorkspaceReadStore,
} from '@orvex-review/store';
import { checkRateLimit } from '../../routes/rate-limit.js';
import {
  llmCostVisibleForTenant,
  reviewRunsForTenant,
  workspaceStatsForTenant,
} from '../../routes/cost-visibility.js';

/** Persistence used by tenant JSON queries and mutations; intentionally not the database facade. */
export type WorkspaceApiStore = WorkspaceReadStore &
  Pick<TenancyRepository, 'getInstallationsForTenant'> &
  Pick<
    RepositoryWriteRepository,
    'setRepoEnabled' | 'updateRepoSettings' | 'updateWorkspaceSettings' | 'upsertRepo'
  > & { listRepos(tenantId: string): ReturnType<RepositoryWriteRepository['upsertRepo']>[] };

export type RepoPatch = {
  enabled?: boolean;
  reviewMode?: 'normal' | 'strict';
  autoApply?: boolean;
  reviewOnOpen?: boolean;
  reviewOnPush?: boolean;
};

export type WorkspaceSettingsPatch = {
  defaultReviewMode?: 'normal' | 'strict';
  autoApplyDefault?: boolean;
  maxComments?: number;
  autoEnableNewRepos?: boolean;
};

export class WorkspaceApiService {
  constructor(
    private readonly store: WorkspaceApiStore,
    private readonly options: {
      costVisibilityTenants: readonly string[];
      githubConfig?: GitHubAppConfig;
    },
  ) {}

  stats(tenant: Tenant, days: number) {
    return workspaceStatsForTenant(
      this.store.getWorkspaceStats(tenant.id, clamp(days, 1, 365)),
      this.canViewCost(tenant),
    );
  }

  reviews(tenant: Tenant, limit: number) {
    return reviewRunsForTenant(
      this.store.listReviewRuns(tenant.id, clamp(limit, 1, 200)),
      this.canViewCost(tenant),
    );
  }

  installations(tenant: Tenant) {
    return this.store.getInstallationsForTenant(tenant.id).map((installation) => ({
      installationId: installation.installationId,
      account: installation.accountLogin,
      accountType: installation.accountType,
      repositorySelection: installation.repositorySelection,
      suspended: Boolean(installation.suspendedAt),
      updatedAt: installation.updatedAt,
    }));
  }

  repos(tenant: Tenant) {
    return this.store.listRepos(tenant.id);
  }

  async syncRepos(
    tenant: Tenant,
  ): Promise<
    | { kind: 'unavailable' }
    | { kind: 'rate_limited'; retryAfterSeconds: number }
    | { kind: 'ok'; synced: number; repos: ReturnType<WorkspaceApiStore['listRepos']> }
  > {
    const limit = checkRateLimit(`repos-sync:${tenant.id}`, { windowMs: 60_000, max: 3 });
    if (!limit.allowed) return { kind: 'rate_limited', retryAfterSeconds: limit.retryAfterSeconds };
    if (!this.options.githubConfig) return { kind: 'unavailable' };
    const settings = this.store.getWorkspaceSettings(tenant.id);
    let synced = 0;
    for (const installation of this.store.getInstallationsForTenant(tenant.id)) {
      if (installation.suspendedAt) continue;
      try {
        const repos = await listInstallationRepos(
          this.options.githubConfig,
          installation.installationId,
        );
        for (const repo of repos) {
          this.store.upsertRepo({
            installationId: installation.installationId,
            tenantId: tenant.id,
            githubRepoId: repo.githubRepoId,
            owner: repo.owner,
            name: repo.name,
            fullName: repo.fullName,
            private: repo.private,
            defaultBranch: repo.defaultBranch,
            enabled: settings.autoEnableNewRepos,
          });
          synced += 1;
        }
      } catch (error) {
        console.warn(
          `[workspace-api] repo sync failed for installation ${installation.installationId}:`,
          error,
        );
      }
    }
    return { kind: 'ok', synced, repos: this.store.listRepos(tenant.id) };
  }

  updateRepo(tenant: Tenant, repoId: string, patch: RepoPatch) {
    const repo = this.store.listRepos(tenant.id).find((candidate) => candidate.id === repoId);
    if (!repo) return null;
    if (typeof patch.enabled === 'boolean') this.store.setRepoEnabled(repoId, patch.enabled);
    if (
      patch.reviewMode ||
      typeof patch.autoApply === 'boolean' ||
      typeof patch.reviewOnOpen === 'boolean' ||
      typeof patch.reviewOnPush === 'boolean'
    ) {
      this.store.updateRepoSettings(repoId, patch);
    }
    return this.store.listRepos(tenant.id).find((candidate) => candidate.id === repoId) ?? null;
  }

  pulls(tenant: Tenant, state: string | undefined, limit: number) {
    const safeState =
      state === 'open' || state === 'closed' || state === 'merged' ? state : undefined;
    return {
      counts: this.store.getPullRequestCounts(tenant.id),
      pulls: this.store.listPullRequests(tenant.id, {
        state: safeState,
        limit: clamp(limit, 1, 300),
      }),
    };
  }

  findings(
    tenant: Tenant,
    status: string | undefined,
    repoFullName: string | undefined,
    limit: number,
  ) {
    const safeStatus =
      status === 'open' || status === 'fixed' || status === 'ignored' ? status : undefined;
    return {
      counts: this.store.getFindingCounts(tenant.id),
      findings: this.store.listFindings(tenant.id, {
        status: safeStatus,
        repoFullName,
        limit: clamp(limit, 1, 500),
      }),
    };
  }

  settings(tenant: Tenant) {
    return this.store.getWorkspaceSettings(tenant.id);
  }

  updateSettings(tenant: Tenant, patch: WorkspaceSettingsPatch) {
    const normalized: WorkspaceSettingsPatch = {};
    if (patch.defaultReviewMode) normalized.defaultReviewMode = patch.defaultReviewMode;
    if (typeof patch.autoApplyDefault === 'boolean')
      normalized.autoApplyDefault = patch.autoApplyDefault;
    if (typeof patch.maxComments === 'number')
      normalized.maxComments = clamp(patch.maxComments, 1, 50);
    if (typeof patch.autoEnableNewRepos === 'boolean')
      normalized.autoEnableNewRepos = patch.autoEnableNewRepos;
    return this.store.updateWorkspaceSettings(tenant.id, normalized);
  }

  overview(tenant: Tenant) {
    const canViewCost = this.canViewCost(tenant);
    return {
      stats: workspaceStatsForTenant(this.store.getWorkspaceStats(tenant.id, 14), canViewCost),
      pullRequests: this.store.getPullRequestCounts(tenant.id),
      findings: this.store.getFindingCounts(tenant.id),
      repos: this.store
        .listRepos(tenant.id)
        .map((repo) => ({ fullName: repo.fullName, enabled: repo.enabled })),
      recentReviews: reviewRunsForTenant(this.store.listReviewRuns(tenant.id, 8), canViewCost),
    };
  }

  private canViewCost(tenant: Tenant): boolean {
    return llmCostVisibleForTenant(tenant.slug, this.options.costVisibilityTenants);
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, Math.floor(value))) : minimum;
}
