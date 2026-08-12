import fs from 'node:fs';
import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';
import { loadGitHubRuntimeConfig } from '@orvex-review/config';
import type { GitHubAppConfig } from './types.js';
import {
  createThrottledInstallationOctokit,
  type CreateInstallationOctokitOptions,
} from './throttled-octokit.js';

export function createInstallationOctokit(
  config: GitHubAppConfig,
  installationId: number,
  options?: CreateInstallationOctokitOptions,
): Octokit {
  // Throttling plugin + optional per-installation pacer. App auth must use
  // authStrategy + options object (plain token auth rejects the object form).
  return createThrottledInstallationOctokit(config, installationId, options);
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
