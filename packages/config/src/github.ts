import { currentEnvironment } from './runtime.js';

export interface GitHubRuntimeConfig {
  readonly appId: string | undefined;
  readonly privateKeyPath: string | undefined;
  readonly privateKeyInline: string | undefined;
  readonly webhookSecret: string;
  readonly botLogin: string;
  readonly allowedRepo: string | undefined;
  readonly appSlug: string | undefined;
  readonly allowUnsignedWebhooks: boolean;
}

function isProductionEnvironment(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV === 'production' || env.ORVEX_ENV === 'production';
}

export function loadGitHubRuntimeConfig(
  env: NodeJS.ProcessEnv = currentEnvironment(),
): GitHubRuntimeConfig {
  if (env.ORVEX_ALLOW_UNSIGNED_WEBHOOKS === '1' && isProductionEnvironment(env)) {
    throw new Error('ORVEX_ALLOW_UNSIGNED_WEBHOOKS is only permitted outside production');
  }
  return Object.freeze({
    appId: env.GITHUB_APP_ID,
    privateKeyPath: env.GITHUB_APP_PRIVATE_KEY_PATH,
    privateKeyInline: env.GITHUB_APP_PRIVATE_KEY,
    webhookSecret: env.GITHUB_WEBHOOK_SECRET ?? '',
    botLogin: env.GITHUB_APP_BOT_LOGIN ?? 'orvex-review[bot]',
    allowedRepo: env.GITHUB_ALLOWED_REPO,
    appSlug: env.GITHUB_APP_SLUG,
    allowUnsignedWebhooks: env.ORVEX_ALLOW_UNSIGNED_WEBHOOKS === '1',
  });
}
