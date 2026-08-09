import {
  buildAuthorizeUrl,
  buildGoogleAuthorizeUrl,
  exchangeCodeForUser,
  exchangeGoogleCodeForUser,
  type GitHubOAuthUser,
  type GoogleOAuthUser,
  type OAuthConfig,
  type OAuthProvider,
} from '@orvex-review/tenants';

export type OAuthIdentity =
  | { provider: 'github'; profile: GitHubOAuthUser }
  | { provider: 'google'; profile: GoogleOAuthUser };

export interface OAuthProviderAdapter {
  readonly provider: OAuthProvider;
  configured(): boolean;
  authorizationUrl(redirectUri: string, state: string): string | null;
  exchange(code: string, redirectUri: string): Promise<OAuthIdentity>;
}

class GitHubOAuthAdapter implements OAuthProviderAdapter {
  readonly provider = 'github' as const;
  constructor(private readonly config: () => OAuthConfig | null) {}
  configured(): boolean {
    return Boolean(this.config());
  }
  authorizationUrl(redirectUri: string, state: string): string | null {
    const config = this.config();
    return config ? buildAuthorizeUrl(config, redirectUri, state) : null;
  }
  async exchange(code: string, redirectUri: string): Promise<OAuthIdentity> {
    const config = this.config();
    if (!config) throw new OAuthConfigurationError(this.provider);
    return {
      provider: this.provider,
      profile: await exchangeCodeForUser(config, code, redirectUri),
    };
  }
}

class GoogleOAuthAdapter implements OAuthProviderAdapter {
  readonly provider = 'google' as const;
  constructor(private readonly config: () => OAuthConfig | null) {}
  configured(): boolean {
    return Boolean(this.config());
  }
  authorizationUrl(redirectUri: string, state: string): string | null {
    const config = this.config();
    return config ? buildGoogleAuthorizeUrl(config, redirectUri, state) : null;
  }
  async exchange(code: string, redirectUri: string): Promise<OAuthIdentity> {
    const config = this.config();
    if (!config) throw new OAuthConfigurationError(this.provider);
    return {
      provider: this.provider,
      profile: await exchangeGoogleCodeForUser(config, code, redirectUri),
    };
  }
}

export class OAuthConfigurationError extends Error {
  constructor(provider: OAuthProvider) {
    super(`${provider} OAuth is not configured`);
    this.name = 'OAuthConfigurationError';
  }
}

export class OAuthProviders {
  private readonly adapters: Readonly<Record<OAuthProvider, OAuthProviderAdapter>>;
  constructor(
    input: Readonly<
      | { github: OAuthConfig | null; google: OAuthConfig | null }
      | Record<OAuthProvider, OAuthProviderAdapter>
    >,
  ) {
    if (isAdapterMap(input)) {
      this.adapters = input;
      return;
    }
    this.adapters = Object.freeze({
      github: new GitHubOAuthAdapter(() => input.github),
      google: new GoogleOAuthAdapter(() => input.google),
    });
  }

  get(provider: OAuthProvider): OAuthProviderAdapter {
    return this.adapters[provider];
  }
  options(): { github: boolean; google: boolean } {
    return { github: this.adapters.github.configured(), google: this.adapters.google.configured() };
  }
}

function isAdapterMap(
  value: Readonly<
    | { github: OAuthConfig | null; google: OAuthConfig | null }
    | Record<OAuthProvider, OAuthProviderAdapter>
  >,
): value is Readonly<Record<OAuthProvider, OAuthProviderAdapter>> {
  return Boolean(
    value.github && typeof (value.github as OAuthProviderAdapter).configured === 'function',
  );
}
