import { Hono, type Context } from 'hono';
import { getCookie } from 'hono/cookie';
import type { IdentityRepository, TenancyRepository, User } from '@orvex-review/store';
import type { OAuthProvider } from '@orvex-review/tenants';
import {
  consoleIdentityAuditSink,
  developmentUser,
  DurableIdentityRateLimits,
  IdentityService,
  MfaChallengeFlow,
  OAuthLoginFlow,
  OAuthProviders,
  PasswordSessionFlow,
  RequestSecurity,
  safeNext,
  type IdentityStore,
} from '../application/identity/index.js';
import {
  rememberGitHubAccessToken,
  setGitHubInstallProof,
  setOAuthReauthProof,
} from '../application/identity/session-proofs.js';
import {
  loginRedirect,
  logoutCsrfToken,
  SESSION_COOKIE,
  sessionUser,
  setSessionCookie,
} from '../application/identity/session-browser.js';
import type { ServerConfig } from '../bootstrap/config.js';
import { loginPage, logoutPage, mfaPage, registerPage } from './session-views.js';

export {
  consumeGitHubInstallProof,
  consumeOAuthReauthProof,
  peekGitHubInstallProof,
  peekOAuthReauthProof,
  recentGitHubAccessToken,
  rememberGitHubAccessToken,
  setGitHubInstallProof,
  setOAuthReauthProof,
} from '../application/identity/session-proofs.js';
export {
  loginRedirect,
  logoutCsrfToken,
  SESSION_COOKIE,
  sessionUser,
  setSessionCookie,
} from '../application/identity/session-browser.js';

type SessionStore = IdentityStore &
  Pick<
    IdentityRepository,
    | 'clearAuthAttempts'
    | 'clearMfaAttempts'
    | 'consumeAuthAttempt'
    | 'consumeMfaAttempt'
    | 'deleteSession'
    | 'getSessionUser'
    | 'setUserNormalizedEmailIfMissing'
    | 'upsertUserFromGitHub'
    | 'upsertUserFromGoogle'
  > &
  Pick<TenancyRepository, 'getWorkspacesForUser'>;

export interface SessionRouteDependencies {
  db: SessionStore;
  config: Pick<
    ServerConfig,
    'appUrl' | 'authDisabled' | 'identity' | 'oauth' | 'platformSecret' | 'requireLogin'
  >;
}

/** Transport-only authentication routes. Identity rules live in focused application flows. */
export function sessionRoutes(dependencies: SessionRouteDependencies) {
  const { db, config } = dependencies;
  const app = new Hono();
  const requestSecurity = new RequestSecurity({
    appUrl: config.appUrl,
    platformSecret: config.platformSecret,
    trustedProxyIps: config.identity.trustedProxyIps,
  });
  const identity = new IdentityService(
    db,
    config.platformSecret,
    config.requireLogin,
    consoleIdentityAuditSink,
  );
  const rateLimits = new DurableIdentityRateLimits(db, config.identity.rateLimits);
  const passwords = new PasswordSessionFlow(identity, rateLimits);
  const mfa = new MfaChallengeFlow(db, identity, rateLimits);
  const oauth = new OAuthLoginFlow(db, identity, new OAuthProviders(config.oauth), config);

  app.get('/auth/register', (c) => {
    const next = safeNext(c.req.query('next') ?? '/connect');
    if (config.authDisabled) return c.redirect(next);
    return c.html(
      registerPage(next, c.req.query('error'), requestSecurity.issueLoginCsrf(c), oauth.options()),
    );
  });

  app.post('/auth/register', async (c) => {
    const body = await c.req.parseBody();
    const next = safeNext(stringBody(body.next) ?? '/connect');
    const result = passwords.register({
      email: (stringBody(body.email) ?? '').trim().toLowerCase(),
      password: stringBody(body.password) ?? '',
      confirmPassword: stringBody(body.confirmPassword) ?? '',
      acceptedTerms: body.acceptedTerms === '1',
      csrfValid: requestSecurity.validLoginCsrf(c, stringBody(body.csrf) ?? ''),
      ip: requestSecurity.clientIp(c),
      next,
    });
    if (result.kind === 'rate_limited') {
      c.header('Retry-After', String(result.retryAfterSeconds));
      return c.html(
        registerPage(next, 'rate', requestSecurity.loginCsrf(c) ?? '', oauth.options()),
        429,
      );
    }
    if (result.kind === 'invalid') {
      const status = result.reason === 'exists' ? 409 : result.reason === 'csrf' ? 403 : 400;
      const csrf =
        result.reason === 'csrf'
          ? requestSecurity.issueLoginCsrf(c)
          : (requestSecurity.loginCsrf(c) ?? '');
      return c.html(registerPage(next, result.reason, csrf, oauth.options()), status);
    }
    return beginIdentitySession(c, passwords, requestSecurity, result.user, next);
  });

  app.get('/auth/login', (c) => {
    const next = safeNext(c.req.query('next'));
    if (config.authDisabled) {
      const session = db.createSession(developmentUser(db).id);
      setSessionCookie(c, session.id, config);
      return c.redirect(next);
    }
    const csrf = requestSecurity.issueLoginCsrf(c);
    const options = oauth.options();
    if (identity.passwordAuthEnabled() || options.github || options.google) {
      return c.html(loginPage(next, c.req.query('error'), csrf, options));
    }
    const location = oauth.begin('github', next, csrf);
    return location ? c.redirect(location) : c.redirect('/connect');
  });

  app.post('/auth/login', async (c) => {
    const body = await c.req.parseBody();
    const next = safeNext(stringBody(body.next));
    const result = passwords.login({
      email: (stringBody(body.email) ?? '').trim().toLowerCase(),
      password: stringBody(body.password) ?? '',
      csrfValid: requestSecurity.validLoginCsrf(c, stringBody(body.csrf) ?? ''),
      ip: requestSecurity.clientIp(c),
      next,
    });
    if (result.kind === 'rate_limited') {
      c.header('Retry-After', String(result.retryAfterSeconds));
      return c.html(
        loginPage(next, 'rate', requestSecurity.loginCsrf(c) ?? '', oauth.options()),
        429,
      );
    }
    if (result.kind === 'invalid') {
      if (result.reason === 'csrf')
        return c.html(
          loginPage(next, 'csrf', requestSecurity.issueLoginCsrf(c), oauth.options()),
          403,
        );
      return c.redirect(`/auth/login?error=1&next=${encodeURIComponent(next)}`);
    }
    return beginIdentitySession(c, passwords, requestSecurity, result.user, next);
  });

  app.get('/auth/github', (c) => beginOAuth(c, oauth, requestSecurity, 'github'));
  app.get('/auth/google', (c) => beginOAuth(c, oauth, requestSecurity, 'google'));

  app.get('/auth/github/prove', (c) => {
    const user = sessionUser(c, db, config);
    const requestedNext = safeNext(c.req.query('next') ?? '/connect');
    if (!user)
      return loginRedirect(c, `/auth/github/prove?next=${encodeURIComponent(requestedNext)}`);
    const csrf = requestSecurity.issueLoginCsrf(c);
    const location = oauth.begin('github', requestedNext, csrf, 'install-proof', user.id);
    return location
      ? c.redirect(location)
      : c.redirect(
          `/connect?error=${encodeURIComponent('GitHub proof is unavailable; configure GitHub OAuth and try again.')}`,
        );
  });

  app.get('/auth/reauth', (c) => {
    const user = sessionUser(c, db, config);
    if (!user) return loginRedirect(c, '/settings/security');
    const provider = oauth.providerForReauthentication(user, c.req.query('provider'));
    if (!provider) return c.redirect('/settings/security?error=reauth');
    const next = safeNext(c.req.query('next') ?? '/settings/security');
    const location = oauth.begin(
      provider,
      next,
      requestSecurity.issueLoginCsrf(c),
      'mfa-proof',
      user.id,
    );
    return location ? c.redirect(location) : c.redirect('/settings/security?error=reauth');
  });

  app.get('/auth/oauth/callback', (c) =>
    finishOAuth(c, 'github', oauth, requestSecurity, db, config, passwords),
  );
  app.get('/auth/google/callback', (c) =>
    finishOAuth(c, 'google', oauth, requestSecurity, db, config, passwords),
  );

  app.get('/auth/2fa', (c) => {
    if (!mfa.exists(requestSecurity.mfaChallenge(c))) {
      requestSecurity.clearMfaChallenge(c);
      return c.redirect('/auth/login');
    }
    return c.html(mfaPage(c.req.query('error')));
  });

  app.post('/auth/2fa', async (c) => {
    const result = await mfa.complete({
      challengeId: requestSecurity.mfaChallenge(c),
      code: (stringBody((await c.req.parseBody()).code) ?? '').trim(),
      ip: requestSecurity.clientIp(c),
    });
    if (result.kind === 'missing') {
      requestSecurity.clearMfaChallenge(c);
      return c.redirect('/auth/login');
    }
    if (result.kind === 'rate_limited') {
      c.header('Retry-After', String(result.retryAfterSeconds));
      return c.html(mfaPage('rate'), 429);
    }
    if (result.kind === 'invalid') return c.redirect('/auth/2fa?error=1');
    requestSecurity.clearMfaChallenge(c);
    requestSecurity.setSession(c, result.sessionId);
    return c.redirect(result.destination);
  });

  app.get('/auth/logout', (c) => {
    const user = sessionUser(c, db, config);
    const csrf = logoutCsrfToken(c, config);
    return user && csrf ? c.html(logoutPage(csrf)) : c.redirect('/auth/login');
  });

  app.post('/auth/logout', async (c) => {
    const body = await c.req.parseBody();
    if (!requestSecurity.validLogoutCsrf(c, stringBody(body.csrf) ?? ''))
      return c.text('Invalid security token', 403);
    const sessionId = getCookie(c, SESSION_COOKIE);
    if (sessionId) db.deleteSession(sessionId);
    requestSecurity.clearSession(c);
    if (sessionId) identity.auditEvent({ action: 'session_revoked', outcome: 'accepted' });
    return c.redirect('/connect');
  });

  app.get('/api/me', (c) => {
    const user = sessionUser(c, db, config);
    if (!user) return c.json({ error: 'not signed in' }, 401);
    return c.json({
      user: {
        id: user.id,
        login: user.login,
        name: user.name,
        avatarUrl: user.avatarUrl,
        isSuperAdmin: user.isSuperAdmin,
        totpEnabled: db.getUserSecurity(user.id).totpEnabled,
      },
      workspaces: db.getWorkspacesForUser(user.id).map((workspace) => ({
        slug: workspace.tenant.slug,
        name: workspace.tenant.name,
        role: workspace.role,
      })),
    });
  });

  return app;
}

function beginOAuth(
  c: Context,
  oauth: OAuthLoginFlow,
  security: RequestSecurity,
  provider: OAuthProvider,
): Response {
  const next = safeNext(c.req.query('next') ?? '/connect');
  const location = oauth.begin(provider, next, security.loginCsrf(c) ?? security.issueLoginCsrf(c));
  return location ? c.redirect(location) : c.redirect(`/auth/login?error=${provider}`);
}

async function finishOAuth(
  c: Context,
  provider: OAuthProvider,
  oauth: OAuthLoginFlow,
  security: RequestSecurity,
  db: SessionStore,
  config: SessionRouteDependencies['config'],
  passwords: PasswordSessionFlow,
): Promise<Response> {
  const state = c.req.query('state');
  const nonce = state ? oauth.stateNonce(state, provider) : null;
  const csrfValid = Boolean(nonce && security.loginCsrf(c) && security.validLoginCsrf(c, nonce));
  if (csrfValid) security.clearLoginCsrf(c);
  const result = await oauth.callback({
    provider,
    code: c.req.query('code'),
    state,
    csrfValid,
    currentUser: sessionUser(c, db, config),
  });
  if (result.kind === 'failed')
    return c.redirect(`/auth/login?error=${provider}&next=${encodeURIComponent(result.next)}`);
  if (result.kind === 'install_proof') {
    rememberGitHubAccessToken(result.userId, result.token);
    setGitHubInstallProof(c, result.userId, result.token, config);
    return c.redirect(result.destination);
  }
  if (result.kind === 'reauthenticated') {
    setOAuthReauthProof(c, result.userId, result.provider, config);
    return c.redirect(result.destination);
  }
  if (result.githubAccessToken) rememberGitHubAccessToken(result.user.id, result.githubAccessToken);
  return beginIdentitySession(c, passwords, security, result.user, result.destination);
}

function beginIdentitySession(
  c: Context,
  passwords: PasswordSessionFlow,
  security: RequestSecurity,
  user: User,
  next: string,
): Response {
  try {
    const started = passwords.begin(user, next);
    if (started.kind === 'mfa') {
      security.setMfaChallenge(c, started.challengeId);
      return c.redirect('/auth/2fa');
    }
    security.setSession(c, started.sessionId);
    return c.redirect(started.destination);
  } catch (error) {
    if (passwords.configurationError(error)) {
      return c.json(
        { error: error instanceof Error ? error.message : 'identity configuration error' },
        500,
      );
    }
    throw error;
  }
}

function stringBody(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
