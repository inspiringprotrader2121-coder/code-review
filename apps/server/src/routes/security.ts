import { createHmac, timingSafeEqual } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { getCookie } from 'hono/cookie';
import QRCode from 'qrcode';
import { createAppDatabase, type AppDatabase, type User } from '@orvex-review/store';
import {
  decryptTotpSecret,
  encryptTotpSecret,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  platformSecret,
  recoveryCodeMatches,
  totpEnrollmentUri,
  verifyPassword,
  verifyTotpCodeWithEpoch,
} from '@orvex-review/tenants';
import { checkRateLimit, clearRateLimit } from './rate-limit.js';
import { escapeHtml, pageShell } from './pages.js';
import { setSessionCookie, SESSION_COOKIE, sessionUser } from './session.js';

const SECURITY_WINDOW_MS = 10 * 60_000;
const SECURITY_MAX_ATTEMPTS = 5;

export function securityRoutes() {
  const app = new Hono();
  const db = createAppDatabase();

  app.use('/settings/security/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });
  app.use('/settings/security', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });

  app.get('/settings/security', (c) => {
    const user = sessionUser(c, db);
    if (!user) return c.redirect('/auth/login?next=/settings/security');
    return c.html(
      securityPage(user, db.getUserSecurity(user.id), csrfToken(c), {
        error: c.req.query('error'),
        disabled: c.req.query('disabled') === '1',
      }),
    );
  });

  app.post('/settings/security/totp/start', async (c) => {
    const user = sessionUser(c, db);
    if (!user) return c.redirect('/auth/login?next=/settings/security');
    if (!(await validCsrf(c))) return c.text('Invalid security token', 403);
    if (db.getUserSecurity(user.id).totpEnabled) return c.redirect('/settings/security');

    const secret = generateTotpSecret();
    if (!db.setPendingTotpSecret(user.id, encryptTotpSecret(secret, platformSecret()))) {
      return c.redirect('/settings/security');
    }
    return c.redirect('/settings/security/totp/setup');
  });

  app.get('/settings/security/totp/setup', async (c) => {
    const user = sessionUser(c, db);
    if (!user) return c.redirect('/auth/login?next=/settings/security/totp/setup');
    const security = db.getUserSecurity(user.id);
    if (security.totpEnabled) return c.redirect('/settings/security');
    const secret = security.totpSecretEncrypted
      ? decryptTotpSecret(security.totpSecretEncrypted, platformSecret())
      : null;
    if (!secret) return c.redirect('/settings/security');

    const uri = totpEnrollmentUri(user.email ?? user.login, secret);
    const qr = await QRCode.toDataURL(uri, { errorCorrectionLevel: 'M', margin: 1, width: 240 });
    return c.html(totpSetupPage(user, secret, qr, csrfToken(c), c.req.query('error')));
  });

  app.post('/settings/security/totp/verify', async (c) => {
    const user = sessionUser(c, db);
    if (!user) return c.redirect('/auth/login?next=/settings/security');
    if (!(await validCsrf(c))) return c.text('Invalid security token', 403);
    const limit = checkSecurityRateLimit(c, db, user.id, 'enable');
    if (!limit.allowed) return c.redirect('/settings/security/totp/setup?error=rate');

    const body = await c.req.parseBody();
    const password = String(body.password ?? '');
    const encrypted = db.getUserSecurity(user.id).totpSecretEncrypted;
    const secret = encrypted ? decryptTotpSecret(encrypted, platformSecret()) : null;
    const totp = secret
      ? await verifyTotpCodeWithEpoch(secret, String(body.code ?? ''))
      : { valid: false as const };
    if (!verifyPassword(password, db.getPasswordHash(user.id)) || !totp.valid || totp.epoch === undefined || !encrypted) {
      return c.redirect('/settings/security/totp/setup?error=code');
    }

    const codes = generateRecoveryCodes();
    const hashes = codes.map((code) => hashRecoveryCode(user.id, code, platformSecret()));
    const session = db.completeTotpEnrollment({
      userId: user.id,
      expectedEncryptedSecret: encrypted,
      totpEpoch: totp.epoch,
      recoveryCodeHashes: hashes,
    });
    if (!session) return c.redirect('/settings/security/totp/setup?error=stale');
    setSessionCookie(c, session.id);
    clearSecurityIpRateLimit(limit);
    return c.html(recoveryCodesPage(user, codes));
  });

  app.post('/settings/security/totp/disable', async (c) => {
    const user = sessionUser(c, db);
    if (!user) return c.redirect('/auth/login?next=/settings/security');
    if (!(await validCsrf(c))) return c.text('Invalid security token', 403);
    const limit = checkSecurityRateLimit(c, db, user.id, 'disable');
    if (!limit.allowed) return c.redirect('/settings/security?error=rate');

    const body = await c.req.parseBody();
    const password = String(body.password ?? '');
    const code = String(body.code ?? '');
    const security = db.getUserSecurity(user.id);
    const secret = security.totpSecretEncrypted
      ? decryptTotpSecret(security.totpSecretEncrypted, platformSecret())
      : null;
    const validPassword = verifyPassword(password, db.getPasswordHash(user.id));
    const totp = secret ? await verifyTotpCodeWithEpoch(secret, code) : { valid: false as const };
    const recoveryHash = security.recoveryCodeHashes.find((hash) =>
      recoveryCodeMatches(hash, user.id, code, platformSecret()),
    );
    const factor = totp.valid && totp.epoch !== undefined
      ? { totpEpoch: totp.epoch }
      : recoveryHash
        ? { recoveryCodeHash: recoveryHash }
        : null;
    if (!security.totpEnabled || !validPassword || !factor) {
      return c.redirect('/settings/security?error=invalid');
    }

    const session = db.disableTotpAndRotateSession({ userId: user.id, factor });
    if (!session) return c.redirect('/settings/security?error=invalid');
    setSessionCookie(c, session.id);
    clearSecurityIpRateLimit(limit);
    return c.redirect('/settings/security?disabled=1');
  });

  app.post('/settings/security/recovery/regenerate', async (c) => {
    const user = sessionUser(c, db);
    if (!user) return c.redirect('/auth/login?next=/settings/security');
    if (!(await validCsrf(c))) return c.text('Invalid security token', 403);
    const limit = checkSecurityRateLimit(c, db, user.id, 'recovery');
    if (!limit.allowed) return c.redirect('/settings/security?error=rate');

    const body = await c.req.parseBody();
    const password = String(body.password ?? '');
    const code = String(body.code ?? '');
    const security = db.getUserSecurity(user.id);
    const secret = security.totpSecretEncrypted
      ? decryptTotpSecret(security.totpSecretEncrypted, platformSecret())
      : null;
    const totp = secret ? await verifyTotpCodeWithEpoch(secret, code) : { valid: false as const };
    if (
      !security.totpEnabled ||
      !verifyPassword(password, db.getPasswordHash(user.id)) ||
      !totp.valid ||
      totp.epoch === undefined
    ) {
      return c.redirect('/settings/security?error=invalid');
    }

    const codes = generateRecoveryCodes();
    const hashes = codes.map((recoveryCode) => hashRecoveryCode(user.id, recoveryCode, platformSecret()));
    const session = db.regenerateRecoveryCodesAndRotateSession({
      userId: user.id,
      totpEpoch: totp.epoch,
      recoveryCodeHashes: hashes,
    });
    if (!session) return c.redirect('/settings/security?error=invalid');
    setSessionCookie(c, session.id);
    clearSecurityIpRateLimit(limit);
    return c.html(recoveryCodesPage(user, codes));
  });

  return app;
}

function csrfToken(c: Context): string {
  const sessionId = getCookie(c, SESSION_COOKIE) ?? '';
  return createHmac('sha256', platformSecret()).update(`orvex-csrf-v1:${sessionId}`).digest('base64url');
}

async function validCsrf(c: Context): Promise<boolean> {
  let submitted = c.req.header('x-orvex-csrf');
  if (!submitted) {
    try {
      const form = await c.req.raw.clone().formData();
      const value = form.get('csrf');
      if (typeof value === 'string') submitted = value;
    } catch {
      return false;
    }
  }
  return Boolean(submitted && safeEqual(submitted, csrfToken(c)));
}

function safeEqual(a: string, b: string): boolean {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}

function securityRateIpKey(c: Context, action: string): string {
  const ip = c.req.header('x-real-ip')?.trim() || c.req.header('x-forwarded-for')?.split(',').at(-1)?.trim() || 'unknown';
  return `account-security:ip:${action}:${ip}`;
}

function checkSecurityRateLimit(c: Context, db: AppDatabase, userId: string, action: string) {
  const ipKey = securityRateIpKey(c, action);
  const accountKey = `security:${action}:${userId}`;
  const ip = checkRateLimit(ipKey, { windowMs: SECURITY_WINDOW_MS, max: SECURITY_MAX_ATTEMPTS });
  const account = db.consumeAuthAttempt(accountKey, {
    windowMs: SECURITY_WINDOW_MS,
    max: SECURITY_MAX_ATTEMPTS,
  });
  return {
    allowed: ip.allowed && account.allowed,
    retryAfterSeconds: Math.max(ip.retryAfterSeconds, account.retryAfterSeconds),
    ipKey,
  };
}

function clearSecurityIpRateLimit(limit: { ipKey: string }): void {
  clearRateLimit(limit.ipKey);
}

function securityPage(
  user: User,
  security: ReturnType<ReturnType<typeof createAppDatabase>['getUserSecurity']>,
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
  return pageShell('Account security', `${body}<p><a href="/dashboard">Back to dashboard</a></p>`, user);
}

function totpSetupPage(user: User, secret: string, qr: string, csrf: string, error?: string): string {
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
