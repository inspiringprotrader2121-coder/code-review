import fs from 'node:fs';
import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';
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

export function loadGitHubConfigFromEnv(): GitHubAppConfig {
  const appId = process.env.GITHUB_APP_ID;
  const privateKeyPath = process.env.GITHUB_APP_PRIVATE_KEY_PATH;
  const privateKeyInline = process.env.GITHUB_APP_PRIVATE_KEY;
  const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET ?? '';
  const botLogin = process.env.GITHUB_APP_BOT_LOGIN ?? 'orvex-review[bot]';
  const allowedRepo = process.env.GITHUB_ALLOWED_REPO;
  const appSlug = process.env.GITHUB_APP_SLUG;

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
