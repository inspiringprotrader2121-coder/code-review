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

export function buildGitHubInstallUrl(appSlug: string, state: string): string {
  return `https://github.com/apps/${appSlug}/installations/new?state=${encodeURIComponent(state)}`;
}
