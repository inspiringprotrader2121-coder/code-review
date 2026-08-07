import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';
import { createInstallationOctokit } from './config.js';
import type { GitHubAppConfig } from './types.js';

export async function fetchInstallationMeta(
  config: GitHubAppConfig,
  installationId: number,
): Promise<{
  accountLogin: string;
  accountType: string;
  repositorySelection: string;
  suspendedAt?: string;
}> {
  const appOctokit = new Octokit({
    authStrategy: createAppAuth,
    auth: { appId: config.appId, privateKey: config.privateKey },
  });
  const { data } = await appOctokit.rest.apps.getInstallation({ installation_id: installationId });

  const account = data.account;
  const accountLogin =
    account && 'login' in account ? account.login : account && 'slug' in account ? account.slug : 'unknown';
  const accountType =
    account && 'type' in account ? String(account.type) : account && 'slug' in account ? 'Organization' : 'Unknown';

  return {
    accountLogin,
    accountType,
    repositorySelection: data.repository_selection ?? 'selected',
    suspendedAt: data.suspended_at ?? undefined,
  };
}

export interface InstallationRepo {
  githubRepoId: number;
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch?: string;
}

/** List every repository an installation can access (paginated). */
export async function listInstallationRepos(
  config: GitHubAppConfig,
  installationId: number,
): Promise<InstallationRepo[]> {
  const octokit = createInstallationOctokit(config, installationId);
  const repos: InstallationRepo[] = [];
  let page = 1;
  for (;;) {
    const { data } = await octokit.rest.apps.listReposAccessibleToInstallation({
      per_page: 100,
      page,
    });
    for (const r of data.repositories) {
      repos.push({
        githubRepoId: r.id,
        owner: r.owner.login,
        name: r.name,
        fullName: r.full_name,
        private: r.private,
        defaultBranch: r.default_branch,
      });
    }
    if (data.repositories.length < 100) break;
    page += 1;
  }
  return repos;
}

/**
 * Verify that the currently authenticated GitHub user administers this
 * installation. Visibility through `/user/installations/:id` is insufficient:
 * any organization member may be able to see an installation.
 */
export async function userCanAccessInstallation(
  accessToken: string,
  installationId: number,
  expected?: { accountLogin: string; accountType: string },
): Promise<boolean> {
  if (!accessToken.trim() || !Number.isInteger(installationId) || installationId <= 0) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  const headers = {
    authorization: `Bearer ${accessToken}`,
    accept: 'application/vnd.github+json',
    'user-agent': 'orvex-review',
  };
  try {
    const viewerResponse = await fetch('https://api.github.com/user', {
      signal: controller.signal,
      headers,
    });
    if (!viewerResponse.ok) return false;
    const viewer = (await viewerResponse.json()) as { login?: string };
    const viewerLogin = typeof viewer.login === 'string' ? viewer.login.trim() : '';
    if (!viewerLogin) return false;

    const response = await fetch(`https://api.github.com/user/installations/${installationId}`, {
      signal: controller.signal,
      headers,
    });
    if (!response.ok) return false;
    const data = (await response.json()) as {
      account?: { login?: string; type?: string };
    };
    const accountLogin = data.account?.login?.trim() ?? '';
    const accountType = data.account?.type?.trim().toLowerCase() ?? '';
    if (!accountLogin) return false;
    if (
      expected &&
      (accountLogin.toLowerCase() !== expected.accountLogin.toLowerCase() ||
        accountType !== expected.accountType.trim().toLowerCase())
    ) {
      return false;
    }

    if (accountType === 'organization') {
      const membership = await fetch(
        `https://api.github.com/orgs/${encodeURIComponent(accountLogin)}/memberships/${encodeURIComponent(viewerLogin)}`,
        { signal: controller.signal, headers },
      );
      if (!membership.ok) return false;
      const details = (await membership.json()) as { state?: string; role?: string };
      return details.state === 'active' && details.role === 'admin';
    }
    return accountLogin.toLowerCase() === viewerLogin.toLowerCase();
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function buildGitHubInstallUrl(appSlug: string, state: string): string {
  return `https://github.com/apps/${appSlug}/installations/new?state=${encodeURIComponent(state)}`;
}
