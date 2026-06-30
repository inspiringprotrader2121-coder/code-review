import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';
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
    auth: createAppAuth({ appId: config.appId, privateKey: config.privateKey }),
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

export function buildGitHubInstallUrl(appSlug: string, state: string): string {
  return `https://github.com/apps/${appSlug}/installations/new?state=${encodeURIComponent(state)}`;
}
