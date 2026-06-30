import type { GitHubAppConfig } from '@velatrix-review/github';
import {
  buildGitHubInstallUrl as ghBuildInstallUrl,
  createInstallationOctokit,
  fetchInstallationMeta,
  loadGitHubConfigFromEnv,
} from '@velatrix-review/github';
import type { AppDatabase, GitHubInstallation, Tenant } from '@velatrix-review/store';
import { createAppDatabase } from '@velatrix-review/store';
import { signInstallState, platformSecret } from './install-state.js';

export function appPublicUrl(): string {
  const url = process.env.APP_URL ?? `http://localhost:${process.env.PORT ?? 8787}`;
  return url.replace(/\/$/, '');
}

export function githubAppSlug(config: GitHubAppConfig): string {
  return config.appSlug ?? process.env.GITHUB_APP_SLUG ?? 'velatrix-review';
}

export function buildGitHubInstallUrl(tenantSlug: string, config?: GitHubAppConfig): string {
  const cfg = config ?? loadGitHubConfigFromEnv();
  const slug = githubAppSlug(cfg);
  const state = signInstallState({ tenantSlug, ts: Date.now() }, platformSecret());
  return ghBuildInstallUrl(slug, state);
}

export class TenantService {
  constructor(private db: AppDatabase = createAppDatabase()) {}

  get dbInstance(): AppDatabase {
    return this.db;
  }

  startConnect(tenantSlug: string, displayName?: string): { tenant: Tenant; installUrl: string } {
    const tenant = this.db.getOrCreateTenant(tenantSlug, displayName);
    const installUrl = buildGitHubInstallUrl(tenant.slug);
    return { tenant, installUrl };
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
