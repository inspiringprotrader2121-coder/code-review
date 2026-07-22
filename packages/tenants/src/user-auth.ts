import { createHmac, timingSafeEqual } from 'node:crypto';

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
}

export type OAuthProvider = 'github' | 'google';

/**
 * GitHub App OAuth credentials (the app's "Client ID" / "Client secret" on the
 * app settings page). Returns null when not configured — routes should fall
 * back to a clear setup error, or the AUTH_DISABLED=1 dev bypass.
 */
export function loadOAuthConfigFromEnv(): OAuthConfig | null {
  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/** Google OpenID Connect credentials from Google Auth Platform. */
export function loadGoogleOAuthConfigFromEnv(): OAuthConfig | null {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

export function authDisabled(): boolean {
  return process.env.AUTH_DISABLED === '1';
}

/**
 * Legacy no-login mode: no OAuth provider is configured and dev bypass off. The single
 * source of truth for whether unauthenticated read/connect access is allowed —
 * previously copy-pasted across three route files.
 */
export function legacyAuthMode(hasPasswordUsers = false): boolean {
  // ORVEX_REQUIRE_LOGIN forces auth on even without GitHub OAuth (email/password mode)
  if (process.env.ORVEX_REQUIRE_LOGIN === '1') return false;
  // If ANY email/password account exists, login is in use — auth is NOT legacy.
  // Security-critical route guards MUST pass db.hasPasswordUsers() here: without
  // it, running password auth (but no OAuth and no ORVEX_REQUIRE_LOGIN) left every
  // guard wide open — unauthenticated cross-tenant read/write. Callers that omit
  // it (e.g. a cosmetic dashboard redirect) keep the historical behavior.
  if (hasPasswordUsers) return false;
  return !loadOAuthConfigFromEnv() && !loadGoogleOAuthConfigFromEnv() && !authDisabled();
}

export interface OAuthStatePayload {
  ts: number;
  next?: string;
  nonce: string;
  provider?: OAuthProvider;
}

export function signOAuthState(payload: OAuthStatePayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', secret).update(`oauth.${body}`).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyOAuthState(
  state: string,
  secret: string,
  maxAgeMs = 600_000,
): OAuthStatePayload | null {
  const [body, sig] = state.split('.');
  if (!body || !sig) return null;
  const expected = createHmac('sha256', secret).update(`oauth.${body}`).digest('base64url');
  try {
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch {
    return null;
  }
  let payload: OAuthStatePayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as OAuthStatePayload;
  } catch {
    return null;
  }
  if (!payload.ts || Date.now() - payload.ts > maxAgeMs) return null;
  if (typeof payload.nonce !== 'string' || payload.nonce.length < 32) return null;
  return payload;
}

export function buildAuthorizeUrl(config: OAuthConfig, redirectUri: string, state: string): string {
  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', 'read:user user:email');
  url.searchParams.set('state', state);
  return url.toString();
}

export function buildGoogleAuthorizeUrl(config: OAuthConfig, redirectUri: string, state: string): string {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', state);
  return url.toString();
}

export interface GitHubOAuthUser {
  githubId: number;
  login: string;
  name?: string;
  avatarUrl?: string;
  email?: string;
}

export async function exchangeCodeForUser(
  config: OAuthConfig,
  code: string,
  redirectUri: string,
): Promise<GitHubOAuthUser> {
  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });
  if (!tokenRes.ok) {
    throw new Error(`GitHub OAuth token exchange failed: HTTP ${tokenRes.status}`);
  }
  const tokenJson = (await tokenRes.json()) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!tokenJson.access_token) {
    throw new Error(
      `GitHub OAuth token exchange failed: ${tokenJson.error_description ?? tokenJson.error ?? 'no access_token'}`,
    );
  }

  const userRes = await fetch('https://api.github.com/user', {
    headers: {
      authorization: `Bearer ${tokenJson.access_token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'orvex-review',
    },
  });
  if (!userRes.ok) {
    throw new Error(`GitHub /user lookup failed: HTTP ${userRes.status}`);
  }
  const user = (await userRes.json()) as {
    id: number;
    login: string;
    name?: string | null;
    avatar_url?: string | null;
    email?: string | null;
  };
  const email = await verifiedGitHubEmail(tokenJson.access_token);
  return {
    githubId: user.id,
    login: user.login,
    name: user.name ?? undefined,
    avatarUrl: user.avatar_url ?? undefined,
    email,
  };
}

async function verifiedGitHubEmail(accessToken: string): Promise<string | undefined> {
  const emailsRes = await fetch('https://api.github.com/user/emails', {
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'orvex-review',
    },
  });
  if (!emailsRes.ok) return undefined;
  const emails = (await emailsRes.json()) as Array<{
    email?: string;
    primary?: boolean;
    verified?: boolean;
  }>;
  const verified = emails.find((email) => email.primary && email.verified)
    ?? emails.find((email) => email.verified);
  return verified?.email?.trim().toLowerCase();
}

export interface GoogleOAuthUser {
  googleId: string;
  email: string;
  name?: string;
  avatarUrl?: string;
}

export async function exchangeGoogleCodeForUser(
  config: OAuthConfig,
  code: string,
  redirectUri: string,
): Promise<GoogleOAuthUser> {
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  });
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!tokenRes.ok) throw new Error(`Google OAuth token exchange failed: HTTP ${tokenRes.status}`);
  const token = (await tokenRes.json()) as { access_token?: string };
  if (!token.access_token) throw new Error('Google OAuth token exchange returned no access token');

  const userRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { authorization: `Bearer ${token.access_token}` },
  });
  if (!userRes.ok) throw new Error(`Google user lookup failed: HTTP ${userRes.status}`);
  const user = (await userRes.json()) as {
    sub?: string;
    email?: string;
    email_verified?: boolean;
    name?: string;
    picture?: string;
  };
  if (!user.sub || !user.email || user.email_verified !== true) {
    throw new Error('Google did not provide a verified email address');
  }
  return {
    googleId: user.sub,
    email: user.email.trim().toLowerCase(),
    name: user.name,
    avatarUrl: user.picture,
  };
}
