import { Hono, type Context } from 'hono';
import QRCode from 'qrcode';
import { type IdentityRepository, type User, type UserSecurity } from '@orvex-review/store';
import { totpEnrollmentUri } from '@orvex-review/tenants';
import { escapeHtml, pageShell } from './pages.js';
import {
  consumeOAuthReauthProof,
  peekOAuthReauthProof,
  setSessionCookie,
  sessionUser,
} from './session.js';
import {
  AccountSecurityService,
  type AccountSecurityStore,
  DurableIdentityRateLimits,
  OAuthProviders,
  RequestSecurity,
} from '../application/identity/index.js';
import type { ServerConfig } from '../bootstrap/config.js';

export interface SecurityRouteDependencies {
  db: AccountSecurityStore &
    Pick<
      IdentityRepository,
      | 'consumeAuthAttempt'
      | 'clearAuthAttempts'
      | 'consumeMfaAttempt'
      | 'clearMfaAttempts'
      | 'getSessionUser'
      | 'upsertUserFromGitHub'
    >;
  config: Pick<ServerConfig, 'appUrl' | 'authDisabled' | 'identity' | 'oauth' | 'platformSecret'>;
}

export function securityRoutes(dependencies: SecurityRouteDependencies) {
  const { db, config } = dependencies;
  const app = new Hono();
  const requestSecurity = new RequestSecurity({
    appUrl: config.appUrl,
    platformSecret: config.platformSecret,
    trustedProxyIps: config.identity.trustedProxyIps,
  });
  const rateLimits = new DurableIdentityRateLimits(db, config.identity.rateLimits);
  const oauthProviders = new OAuthProviders(config.oauth);
  const accountSecurity = new AccountSecurityService(db, config.platformSecret);

  app.use('/settings/security/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });
  app.use('/settings/security', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });

  app.get('/settings/security', (c) => {
    const user = sessionUser(c, db, config);
    if (!user) return c.redirect('/auth/login?next=/settings/security');
    return c.html(
      securityPage(user, accountSecurity.security(user.id), requestSecurity.sessionCsrf(c), {
        error: c.req.query('error'),
        disabled: c.req.query('disabled') === '1',
      }),
    );
  });

  app.post('/settings/security/totp/start', async (c) => {
    const user = sessionUser(c, db, config);
    if (!user) return c.redirect('/auth/login?next=/settings/security');
    if (!(await requestSecurity.validSessionCsrf(c))) return c.text('Invalid security token', 403);
    if (accountSecurity.security(user.id).totpEnabled) return c.redirect('/settings/security');
    if (!db.getPasswordHash(user.id)) {
      const provider = mfaReauthProvider(user, oauthProviders);
      if (!provider) return c.redirect('/settings/security?error=reauth');
      if (!peekOAuthReauthProof(c, user.id, config)) {
        return c.redirect(
          `/auth/reauth?provider=${provider}&next=${encodeURIComponent('/settings/security')}`,
        );
      }
    }

    const started = accountSecurity.beginEnrollment(
      user.id,
      peekOAuthReauthProof(c, user.id, config),
    );
    if (started.kind === 'reauth_required') return c.redirect('/settings/security?error=reauth');
    if (started.kind !== 'ok') return c.redirect('/settings/security');
    return c.redirect('/settings/security/totp/setup');
  });

  app.get('/settings/security/totp/start', (c) => {
    // Read-only: enrollment must be CSRF'd POST only. After OAuth reauth the
    // browser may land here via `next=` — send them back to the security page
    // (or setup if a secret is already pending) without generating a secret.
    const user = sessionUser(c, db, config);
    if (!user) return c.redirect('/auth/login?next=/settings/security');
    const security = accountSecurity.security(user.id);
    if (security.totpEnabled) return c.redirect('/settings/security');
    if (security.totpSecretEncrypted) return c.redirect('/settings/security/totp/setup');
    return c.redirect('/settings/security');
  });

  app.get('/settings/security/totp/setup', async (c) => {
    const user = sessionUser(c, db, config);
    if (!user) return c.redirect('/auth/login?next=/settings/security/totp/setup');
    const security = accountSecurity.security(user.id);
    if (security.totpEnabled) return c.redirect('/settings/security');
    const secret = accountSecurity.pendingSecret(user.id);
    if (!secret) return c.redirect('/settings/security');

    const uri = totpEnrollmentUri(user.email ?? user.login, secret);
    const qr = await QRCode.toDataURL(uri, { errorCorrectionLevel: 'M', margin: 1, width: 240 });
    return c.html(
      totpSetupPage(user, secret, qr, requestSecurity.sessionCsrf(c), c.req.query('error')),
    );
  });

  app.post('/settings/security/totp/verify', async (c) => {
    const user = sessionUser(c, db, config);
    if (!user) return c.redirect('/auth/login?next=/settings/security');
    if (!(await requestSecurity.validSessionCsrf(c))) return c.text('Invalid security token', 403);
    const limit = checkSecurityRateLimit(rateLimits, requestSecurity, c, user.id, 'enable');
    if (!limit.allowed) return c.redirect('/settings/security/totp/setup?error=rate');

    const body = await c.req.parseBody();
    const password = String(body.password ?? '');
    const passwordHash = db.getPasswordHash(user.id);
    const result = await accountSecurity.verifyEnrollment({
      userId: user.id,
      password,
      code: String(body.code ?? ''),
      oauthReauthenticated: peekOAuthReauthProof(c, user.id, config),
    });
    if (result.kind !== 'ok' || !result.sessionId || !result.recoveryCodes) {
      return c.redirect('/settings/security/totp/setup?error=code');
    }
    if (!passwordHash) consumeOAuthReauthProof(c, user.id, config);
    setSessionCookie(c, result.sessionId, config);
    clearSecurityRateLimits(rateLimits, limit);
    return c.html(recoveryCodesPage(user, result.recoveryCodes));
  });

  app.post('/settings/security/totp/disable', async (c) => {
    const user = sessionUser(c, db, config);
    if (!user) return c.redirect('/auth/login?next=/settings/security');
    if (!(await requestSecurity.validSessionCsrf(c))) return c.text('Invalid security token', 403);
    const limit = checkSecurityRateLimit(rateLimits, requestSecurity, c, user.id, 'disable');
    if (!limit.allowed) return c.redirect('/settings/security?error=rate');

    const body = await c.req.parseBody();
    const password = String(body.password ?? '');
    const code = String(body.code ?? '');
    const passwordHash = db.getPasswordHash(user.id);
    const result = await accountSecurity.disable({
      userId: user.id,
      password,
      code,
      oauthReauthenticated: peekOAuthReauthProof(c, user.id, config),
    });
    if (result.kind !== 'ok' || !result.sessionId) {
      return c.redirect('/settings/security?error=invalid');
    }
    if (!passwordHash) consumeOAuthReauthProof(c, user.id, config);
    setSessionCookie(c, result.sessionId, config);
    clearSecurityRateLimits(rateLimits, limit);
    return c.redirect('/settings/security?disabled=1');
  });

  app.post('/settings/security/recovery/regenerate', async (c) => {
    const user = sessionUser(c, db, config);
    if (!user) return c.redirect('/auth/login?next=/settings/security');
    if (!(await requestSecurity.validSessionCsrf(c))) return c.text('Invalid security token', 403);
    const limit = checkSecurityRateLimit(rateLimits, requestSecurity, c, user.id, 'recovery');
    if (!limit.allowed) return c.redirect('/settings/security?error=rate');

    const body = await c.req.parseBody();
    const password = String(body.password ?? '');
    const code = String(body.code ?? '');
    const passwordHash = db.getPasswordHash(user.id);
    const result = await accountSecurity.regenerateRecoveryCodes({
      userId: user.id,
      password,
      code,
      oauthReauthenticated: peekOAuthReauthProof(c, user.id, config),
    });
    if (result.kind !== 'ok' || !result.sessionId || !result.recoveryCodes) {
      return c.redirect('/settings/security?error=invalid');
    }
    if (!passwordHash) consumeOAuthReauthProof(c, user.id, config);

    setSessionCookie(c, result.sessionId, config);
    clearSecurityRateLimits(rateLimits, limit);
    return c.html(recoveryCodesPage(user, result.recoveryCodes));
  });

  return app;
}

function mfaReauthProvider(user: User, providers: OAuthProviders): 'github' | 'google' | null {
  if (user.githubId > 0 && providers.get('github').configured()) return 'github';
  if (user.googleId && providers.get('google').configured()) return 'google';
  return null;
}

function checkSecurityRateLimit(
  limits: DurableIdentityRateLimits,
  requestSecurity: RequestSecurity,
  c: Context,
  userId: string,
  action: string,
) {
  const ipKey = limits.ipKey('security', requestSecurity.clientIp(c), action);
  const accountKey = limits.securityAccountKey(userId, action);
  const ip = limits.consume('security_ip', ipKey);
  const account = limits.consume('security_account', accountKey);
  return {
    allowed: ip.allowed && account.allowed,
    retryAfterSeconds: Math.max(ip.retryAfterSeconds, account.retryAfterSeconds),
    ipKey,
    accountKey,
  };
}

function clearSecurityRateLimits(
  limits: DurableIdentityRateLimits,
  limit: { ipKey: string; accountKey: string },
): void {
  limits.clear(limit.ipKey);
}

function securityPage(
  user: User,
  security: UserSecurity,
  csrf: string,
  status: { error?: string; disabled: boolean },
): string {
  const queryMessage = status.disabled
    ? '<div class="banner">Two-factor authentication has been disabled.</div>'
    : status.error
      ? `<div class="banner error">${status.error === 'rate' ? 'Too many attempts. Try again later.' : 'Your password or authentication code was not accepted.'}</div>`
      : '';
  const body = security.totpEnabled
    ? `<h1>Account security</h1>
       <p class="lead">Authenticator two-factor authentication is enabled.</p>
       ${queryMessage}
       <div class="banner">Recovery codes remaining: <strong>${security.recoveryCodeHashes.length}</strong></div>
       <form method="post" action="/settings/security/recovery/regenerate">
         ${csrfInput(csrf)}
         <label for="regen-password">Current password</label>
         <input id="regen-password" name="password" type="password" required autocomplete="current-password" />
         <label for="regen-code">Authenticator code</label>
         <input id="regen-code" name="code" type="text" required inputmode="numeric" autocomplete="one-time-code" />
         <button type="submit">Generate new recovery codes</button>
       </form>
       <hr />
       <h2>Disable two-factor authentication</h2>
       <form method="post" action="/settings/security/totp/disable">
         ${csrfInput(csrf)}
         <label for="password">Current password</label>
         <input id="password" name="password" type="password" required autocomplete="current-password" />
         <label for="disable-code">Authenticator or recovery code</label>
         <input id="disable-code" name="code" type="text" required autocomplete="one-time-code" />
         <button class="danger" type="submit">Disable two-factor authentication</button>
       </form>`
    : `<h1>Account security</h1>
       <p class="lead">Add an authenticator app code after your password when signing in.</p>
       ${queryMessage}
       <div class="banner">Two-factor authentication is currently disabled.</div>
       <form method="post" action="/settings/security/totp/start">
         ${csrfInput(csrf)}
         <button type="submit">Set up authenticator app</button>
       </form>`;
  return pageShell(
    'Account security',
    `${body}<p><a href="/dashboard">Back to dashboard</a></p>`,
    user,
  );
}

function totpSetupPage(
  user: User,
  secret: string,
  qr: string,
  csrf: string,
  error?: string,
): string {
  const banner = error
    ? `<div class="banner error">${error === 'rate' ? 'Too many attempts. Try again later.' : 'That code was not accepted.'}</div>`
    : '';
  return pageShell(
    'Set up authenticator',
    `<h1>Set up authenticator</h1>
       <p class="lead">Scan this code with Google Authenticator, Microsoft Authenticator, Authy, or another TOTP app.</p>
       ${banner}
       <p style="text-align:center"><img src="${qr}" width="240" height="240" alt="Authenticator QR code" /></p>
       <p class="mono" style="word-break:break-all;text-align:center">${escapeHtml(secret)}</p>
       <form method="post" action="/settings/security/totp/verify">
         ${csrfInput(csrf)}
         <label for="password">Current password</label>
         <input id="password" name="password" type="password" required autocomplete="current-password" />
         <label for="code">6-digit code</label>
         <input id="code" name="code" type="text" required autofocus inputmode="numeric" autocomplete="one-time-code" />
         <button type="submit">Verify and enable</button>
       </form>
       <p><a href="/settings/security">Cancel</a></p>`,
    user,
  );
}

function recoveryCodesPage(user: User, codes: string[]): string {
  const list = codes.map((code) => `<li><code>${escapeHtml(code)}</code></li>`).join('');
  return pageShell(
    'Recovery codes',
    `<h1>Save your recovery codes</h1>
     <p class="lead">Each code can be used once if your authenticator is unavailable. These codes will not be shown again.</p>
     <ol style="columns:2;list-style:none;padding:0">${list}</ol>
     <p><a class="btn" href="/settings/security">Done</a></p>`,
    user,
  );
}

function csrfInput(token: string): string {
  return `<input type="hidden" name="csrf" value="${escapeHtml(token)}" />`;
}
