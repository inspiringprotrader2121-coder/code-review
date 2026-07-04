import type { GitHubAppConfig } from '@orvex-review/github';
import {
  buildGitHubInstallUrl as ghBuildInstallUrl,
  createInstallationOctokit,
  fetchInstallationMeta,
  loadGitHubConfigFromEnv,
} from '@orvex-review/github';
import type { AppDatabase, GitHubInstallation, Tenant } from '@orvex-review/store';
import { createAppDatabase } from '@orvex-review/store';
import { signInstallState, platformSecret } from './install-state.js';

export function appPublicUrl(): string {
  const url = process.env.APP_URL ?? `http://localhost:${process.env.PORT ?? 8787}`;
  return url.replace(/\/$/, '');
}

export function githubAppSlug(config: GitHubAppConfig): string {
  return config.appSlug ?? process.env.GITHUB_APP_SLUG ?? 'orvex-review';
}

export function buildGitHubInstallUrl(
  tenantSlug: string,
  config?: GitHubAppConfig,
  userId?: string,
): string {
  const cfg = config ?? loadGitHubConfigFromEnv();
  const slug = githubAppSlug(cfg);
  const state = signInstallState({ tenantSlug, ts: Date.now(), userId }, platformSecret());
  return ghBuildInstallUrl(slug, state);
}

export class WorkspaceAccessError extends Error {
  constructor(
    message: string,
    public readonly status: 403 | 404 = 403,
  ) {
    super(message);
    this.name = 'WorkspaceAccessError';
  }
}

export class TenantService {
  constructor(private db: AppDatabase = createAppDatabase()) {}

  get dbInstance(): AppDatabase {
    return this.db;
  }

  /**
   * Begin the connect flow for an authenticated user. Creating a new slug
   * makes the user its owner; an existing slug is only usable by its members
   * (a member-less tenant — pre-auth data — is claimable and the claimer
   * becomes owner).
   */
  startConnect(
    tenantSlug: string,
    userId: string,
    displayName?: string,
  ): { tenant: Tenant; installUrl: string } {
    const existing = this.db.getTenantBySlug(tenantSlug);
    let tenant: Tenant;
    if (existing) {
      if (this.db.tenantHasMembers(existing.id) && !this.db.getMembership(existing.id, userId)) {
        throw new WorkspaceAccessError(`Workspace slug "${existing.slug}" is already taken`);
      }
      if (!this.db.getMembership(existing.id, userId)) {
        this.db.addWorkspaceMember(existing.id, userId, 'owner');
      }
      tenant = existing;
    } else {
      tenant = this.db.createTenant(tenantSlug, displayName);
      this.db.addWorkspaceMember(tenant.id, userId, 'owner');
    }
    const installUrl = buildGitHubInstallUrl(tenant.slug, undefined, userId);
    return { tenant, installUrl };
  }

  /**
   * Pre-auth connect flow, used only while user login (OAuth) is not
   * configured. No membership is created; the first user to sign in after
   * accounts are enabled can claim the workspace (member-less tenants are
   * claimable in startConnect).
   */
  startConnectLegacy(tenantSlug: string, displayName?: string): { tenant: Tenant; installUrl: string } {
    const tenant = this.db.getOrCreateTenant(tenantSlug, displayName);
    const installUrl = buildGitHubInstallUrl(tenant.slug);
    return { tenant, installUrl };
  }

  /** Tenant status, only if the user is a member. */
  getTenantStatusForUser(
    slug: string,
    userId: string,
  ): { tenant: Tenant; installations: GitHubInstallation[] } {
    const tenant = this.db.getTenantBySlug(slug);
    if (!tenant) throw new WorkspaceAccessError('workspace not found', 404);
    if (!this.db.getMembership(tenant.id, userId)) {
      throw new WorkspaceAccessError('not a member of this workspace');
    }
    return { tenant, installations: this.db.getInstallationsForTenant(tenant.id) };
  }

  async completeInstallCallback(
    installationId: number,
    tenantSlug: string,
    config?: GitHubAppConfig,
  ): Promise<{ tenant: Tenant; installation: GitHubInstallation }> {
    const cfg = config ?? loadGitHubConfigFromEnv();
    const tenant = this.db.getOrCreateTenant(tenantSlug);
    const meta = await fetchInstallationMeta(cfg, installationId);
    const installation = this.db.upsertInstallation({
      installationId,
      tenantId: tenant.id,
      accountLogin: meta.accountLogin,
      accountType: meta.accountType,
      repositorySelection: meta.repositorySelection,
      suspendedAt: meta.suspendedAt ?? null,
    });
    return { tenant, installation };
  }

  async syncInstallationFromWebhook(
    installationId: number,
    tenantId: string | null,
    meta: {
      accountLogin: string;
      accountType: string;
      repositorySelection: string;
      suspendedAt?: string | null;
    },
  ): Promise<GitHubInstallation | null> {
    let resolvedTenantId = tenantId;
    if (!resolvedTenantId) {
      const existing = this.db.getInstallation(installationId);
      resolvedTenantId = existing?.tenantId ?? null;
    }
    if (!resolvedTenantId) {
      const tenant = this.db.createTenant(`org-${meta.accountLogin}`, meta.accountLogin);
      resolvedTenantId = tenant.id;
    }

    return this.db.upsertInstallation({
      installationId,
      tenantId: resolvedTenantId,
      accountLogin: meta.accountLogin,
      accountType: meta.accountType,
      repositorySelection: meta.repositorySelection,
      suspendedAt: meta.suspendedAt ?? null,
    });
  }

  resolveInstallation(installationId: number): GitHubInstallation | null {
    return this.db.getInstallation(installationId);
  }

  getTenantStatus(slug: string): {
    tenant: Tenant;
    installations: GitHubInstallation[];
  } | null {
    const tenant = this.db.getTenantBySlug(slug);
    if (!tenant) return null;
    return {
      tenant,
      installations: this.db.getInstallationsForTenant(tenant.id),
    };
  }

  async isRepoOnInstallation(
    installationId: number,
    owner: string,
    repo: string,
    config?: GitHubAppConfig,
  ): Promise<boolean> {
    const cfg = config ?? loadGitHubConfigFromEnv();
    const octokit = createInstallationOctokit(cfg, installationId);
    try {
      await octokit.rest.repos.get({ owner, repo });
      return true;
    } catch {
      return false;
    }
  }
}
