import fs from 'node:fs';
import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';
import { loadGitHubRuntimeConfig } from '@orvex-review/config';
import type { GitHubAppConfig } from './types.js';

export function createInstallationOctokit(
  config: GitHubAppConfig,
  installationId: number,
): Octokit {
  // Octokit's default auth strategy treats `auth` as a token string; app auth
  // must be wired via `authStrategy` + an options object, or it throws
  // "Token passed to createTokenAuth is not a string".
  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: config.appId,
      privateKey: config.privateKey,
      installationId,
    },
  });
}

export async function getInstallationIdForRepo(
  config: GitHubAppConfig,
  owner: string,
  repo: string,
): Promise<number> {
  const appOctokit = new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: config.appId,
      privateKey: config.privateKey,
    },
  });

  const { data } = await appOctokit.rest.apps.getRepoInstallation({ owner, repo });
  return data.id;
}

export function loadGitHubConfigFromEnv(env?: NodeJS.ProcessEnv): GitHubAppConfig {
  const runtime = loadGitHubRuntimeConfig(env);
  const { appId, privateKeyPath, privateKeyInline, webhookSecret, botLogin, allowedRepo, appSlug } =
    runtime;

  if (!appId) {
    throw new Error('GITHUB_APP_ID is required');
  }

  let privateKey = privateKeyInline;
  if (!privateKey && privateKeyPath) {
    privateKey = fs.readFileSync(privateKeyPath, 'utf8');
  }
  if (!privateKey) {
    throw new Error('GITHUB_APP_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY_PATH is required');
  }

  return {
    appId,
    privateKey: privateKey.replace(/\\n/g, '\n'),
    webhookSecret,
    botLogin,
    appSlug,
    allowedRepo,
  };
}
