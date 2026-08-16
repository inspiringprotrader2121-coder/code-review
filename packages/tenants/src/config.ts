import { currentEnvironment } from '@orvex-review/config';

export interface TenantOAuthConfig {
  readonly clientId: string;
  readonly clientSecret: string;
}

/** Immutable configuration owned by the tenancy and authentication boundary. */
export interface TenantRuntimeConfig {
  readonly appUrl: string;
  readonly githubAppSlug: string;
  readonly platformSecret: string | null;
  readonly githubOAuth: TenantOAuthConfig | null;
  readonly googleOAuth: TenantOAuthConfig | null;
  readonly authDisabled: boolean;
  readonly requireLogin: boolean;
  readonly defaultPlanId: string | null;
  readonly extraDisposableDomains: readonly string[];
  readonly unlimitedGithubOwners: readonly string[];
  readonly unlimitedAccountEmails: readonly string[];
  readonly unlimitedTenantSlugs: readonly string[];
}

function oauthConfig(
  clientId: string | undefined,
  clientSecret: string | undefined,
): TenantOAuthConfig | null {
  if (!clientId || !clientSecret) return null;
  return Object.freeze({ clientId, clientSecret });
}

function list(raw: string | undefined): readonly string[] {
  return Object.freeze(
    (raw ?? '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * Take one frozen configuration snapshot. Runtime composition may inject it
 * into services; the default preserves the legacy zero-argument helpers.
 */
export function loadTenantRuntimeConfig(
  env: Readonly<NodeJS.ProcessEnv> = currentEnvironment(),
): TenantRuntimeConfig {
  const appUrl = (env.APP_URL ?? `http://localhost:${env.PORT ?? 8787}`).replace(/\/$/, '');
  return Object.freeze({
    appUrl,
    githubAppSlug: env.GITHUB_APP_SLUG ?? 'orvex-review',
    platformSecret: env.PLATFORM_SECRET ?? env.GITHUB_WEBHOOK_SECRET ?? null,
    githubOAuth: oauthConfig(env.GITHUB_OAUTH_CLIENT_ID, env.GITHUB_OAUTH_CLIENT_SECRET),
    googleOAuth: oauthConfig(env.GOOGLE_OAUTH_CLIENT_ID, env.GOOGLE_OAUTH_CLIENT_SECRET),
    authDisabled: env.AUTH_DISABLED === '1',
    requireLogin: env.ORVEX_REQUIRE_LOGIN === '1',
    defaultPlanId: env.ORVEX_DEFAULT_PLAN ?? null,
    extraDisposableDomains: list(env.ORVEX_EXTRA_DISPOSABLE_DOMAINS),
    unlimitedGithubOwners: list(env.ORVEX_UNLIMITED_GITHUB_OWNERS),
    unlimitedAccountEmails: list(env.ORVEX_UNLIMITED_ACCOUNT_EMAILS),
    unlimitedTenantSlugs: list(env.ORVEX_UNLIMITED_TENANT_SLUGS),
  });
}
