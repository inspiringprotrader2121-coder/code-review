import type { IdentityRepository, User } from '@orvex-review/store';
import {
  normalizeEmail,
  signOAuthState,
  type GitHubOAuthUser,
  type GoogleOAuthUser,
  type OAuthProvider,
  verifyOAuthState,
} from '@orvex-review/tenants';
import { IdentityService } from './identity-service.js';
import { OAuthProviders } from './oauth.js';

export type OAuthLoginStore = Pick<
  IdentityRepository,
  'setUserNormalizedEmailIfMissing' | 'upsertUserFromGitHub' | 'upsertUserFromGoogle'
>;

export type OAuthFlowConfig = Readonly<{ appUrl: string; platformSecret: string }>;
export type OAuthCallbackResult =
  | { kind: 'failed'; next: string }
  | { kind: 'install_proof'; userId: string; token: string; destination: string }
  | { kind: 'reauthenticated'; userId: string; provider: OAuthProvider; destination: string }
  | { kind: 'authenticated'; user: User; githubAccessToken?: string; destination: string };

/** Provider exchange and account-linking policy. Routes only manage browser state and HTTP. */
export class OAuthLoginFlow {
  constructor(
    private readonly db: OAuthLoginStore,
    private readonly identity: IdentityService,
    private readonly providers: OAuthProviders,
    private readonly config: OAuthFlowConfig,
  ) {}

  options(): { github: boolean; google: boolean } {
    return this.providers.options();
  }

  begin(
    provider: OAuthProvider,
    next: string,
    nonce: string,
    purpose?: 'install-proof' | 'mfa-proof',
    userId?: string,
  ): string | null {
    const state = signOAuthState(
      { ts: Date.now(), next, nonce, provider, purpose, userId },
      this.config.platformSecret,
    );
    return this.providers.get(provider).authorizationUrl(this.callbackUrl(provider), state);
  }

  /** Checks the signed provider state before the route compares its browser nonce. */
  stateNonce(state: string, provider: OAuthProvider): string | null {
    const payload = verifyOAuthState(state, this.config.platformSecret);
    return payload?.provider === provider ? payload.nonce : null;
  }

  providerForReauthentication(user: User, requested: string | undefined): OAuthProvider | null {
    if (requested === 'github' && user.githubId > 0 && this.providers.get('github').configured())
      return 'github';
    if (requested === 'google' && user.googleId && this.providers.get('google').configured())
      return 'google';
    if (user.githubId > 0 && this.providers.get('github').configured()) return 'github';
    if (user.googleId && this.providers.get('google').configured()) return 'google';
    return null;
  }

  async callback(
    input: Readonly<{
      provider: OAuthProvider;
      code: string | undefined;
      state: string | undefined;
      csrfValid: boolean;
      currentUser: User | null;
    }>,
  ): Promise<OAuthCallbackResult> {
    if (!input.code || !input.state) return { kind: 'failed', next: '/dashboard' };
    const payload = verifyOAuthState(input.state, this.config.platformSecret);
    if (
      !payload ||
      payload.provider !== input.provider ||
      !input.csrfValid ||
      !this.providers.get(input.provider).configured()
    ) {
      return { kind: 'failed', next: payload?.next ?? '/dashboard' };
    }
    const next = safeOAuthNext(payload.next);
    try {
      const result = await this.providers
        .get(input.provider)
        .exchange(input.code, this.callbackUrl(input.provider));
      if (result.provider !== input.provider) return { kind: 'failed', next };
      if (input.provider === 'github')
        return this.finishGitHub(
          result.profile as GitHubOAuthUser,
          payload,
          input.currentUser,
          next,
        );
      return this.finishGoogle(result.profile as GoogleOAuthUser, payload, input.currentUser, next);
    } catch (error) {
      console.warn(
        `[auth] ${input.provider} OAuth callback failed:`,
        error instanceof Error ? error.message : String(error),
      );
      this.identity.auditEvent({
        action: 'oauth_login',
        outcome: 'failed',
        provider: input.provider,
      });
      return { kind: 'failed', next };
    }
  }

  private finishGitHub(
    profile: GitHubOAuthUser,
    payload: NonNullable<ReturnType<typeof verifyOAuthState>>,
    current: User | null,
    next: string,
  ): OAuthCallbackResult {
    if (payload.purpose === 'install-proof') {
      if (!current || payload.userId !== current.id || !profile.accessToken)
        return this.rejectedLink('oauth_link', 'github', next);
      this.identity.auditEvent({
        action: 'oauth_link',
        outcome: 'accepted',
        provider: 'github',
        userId: current.id,
      });
      return {
        kind: 'install_proof',
        userId: current.id,
        token: profile.accessToken,
        destination: next,
      };
    }
    if (payload.purpose === 'mfa-proof') {
      if (!current || payload.userId !== current.id || profile.githubId !== current.githubId)
        return this.rejectedLink('oauth_reauth', 'github', next);
      this.identity.auditEvent({
        action: 'oauth_reauth',
        outcome: 'accepted',
        provider: 'github',
        userId: current.id,
      });
      return { kind: 'reauthenticated', userId: current.id, provider: 'github', destination: next };
    }
    const normalizedEmail = profile.email ? normalizeEmail(profile.email) : undefined;
    const user = this.db.upsertUserFromGitHub({ ...profile, normalizedEmail });
    if (normalizedEmail) this.db.setUserNormalizedEmailIfMissing(user.id, normalizedEmail);
    this.identity.auditEvent({
      action: 'oauth_login',
      outcome: 'accepted',
      provider: 'github',
      userId: user.id,
    });
    return {
      kind: 'authenticated',
      user,
      githubAccessToken: profile.accessToken,
      destination: next,
    };
  }

  private finishGoogle(
    profile: GoogleOAuthUser,
    payload: NonNullable<ReturnType<typeof verifyOAuthState>>,
    current: User | null,
    next: string,
  ): OAuthCallbackResult {
    if (payload.purpose === 'mfa-proof') {
      if (!current || payload.userId !== current.id || profile.googleId !== current.googleId)
        return this.rejectedLink('oauth_reauth', 'google', next);
      this.identity.auditEvent({
        action: 'oauth_reauth',
        outcome: 'accepted',
        provider: 'google',
        userId: current.id,
      });
      return { kind: 'reauthenticated', userId: current.id, provider: 'google', destination: next };
    }
    const normalizedEmail = normalizeEmail(profile.email);
    const user = this.db.upsertUserFromGoogle({ ...profile, normalizedEmail });
    this.db.setUserNormalizedEmailIfMissing(user.id, normalizedEmail);
    this.identity.auditEvent({
      action: 'oauth_login',
      outcome: 'accepted',
      provider: 'google',
      userId: user.id,
    });
    return { kind: 'authenticated', user, destination: next };
  }

  private rejectedLink(
    action: 'oauth_link' | 'oauth_reauth',
    provider: OAuthProvider,
    next: string,
  ): OAuthCallbackResult {
    this.identity.auditEvent({
      action,
      outcome: 'rejected',
      provider,
      reason: 'mismatched_identity',
    });
    return { kind: 'failed', next };
  }

  private callbackUrl(provider: OAuthProvider): string {
    return `${this.config.appUrl}${provider === 'github' ? '/auth/oauth/callback' : '/auth/google/callback'}`;
  }
}

function safeOAuthNext(next: string | undefined): string {
  return !next || !next.startsWith('/') || next.startsWith('//') || next.includes('\\')
    ? '/dashboard'
    : next;
}
