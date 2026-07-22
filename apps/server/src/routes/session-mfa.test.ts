import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { generate } from 'otplib';
import {
  decryptTotpSecret,
  encryptTotpSecret,
  generateTotpSecret,
  hashPassword,
  hashRecoveryCode,
} from '@orvex-review/tenants';

test('password login requires optional MFA and a super-admin session unlocks the admin page', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'orvex-mfa-route-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  process.env.STORE_PATH = path.join(dir, 'app.db');
  process.env.PLATFORM_SECRET = 'test-platform-secret-that-is-not-used-in-production';
  process.env.APP_URL = 'https://example.test';
  process.env.ORVEX_REQUIRE_LOGIN = '1';
  const password = 'Test-only-password-42!';

  const [{ createAppDatabase }, { sessionRoutes }, { superadminRoutes }, { securityRoutes }] = await Promise.all([
    import('@orvex-review/store'),
    import('./session.js'),
    import('./superadmin.js'),
    import('./security.js'),
  ]);
  const db = createAppDatabase();
  const user = db.upsertPasswordUser({
    email: 'admin@example.test',
    passwordHash: hashPassword(password),
  });
  const secret = generateTotpSecret();
  const recoveryCode = 'ABCD-EF01-2345-6789';
  const disableRecoveryCode = '9876-5432-10FE-DCBA';
  db.setPendingTotpSecret(user.id, encryptTotpSecret(secret, process.env.PLATFORM_SECRET));
  db.enableTotp(user.id, [
    hashRecoveryCode(user.id, recoveryCode, process.env.PLATFORM_SECRET),
    hashRecoveryCode(user.id, disableRecoveryCode, process.env.PLATFORM_SECRET),
  ]);

  const sessions = sessionRoutes();
  const csrfDenied = await sessions.request('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-real-ip': '192.0.2.10' },
    body: new URLSearchParams({ email: 'admin@example.test', password, next: '/superadmin' }),
  });
  assert.equal(csrfDenied.status, 403, 'password login requires a browser-bound CSRF token');
  const passwordResponse = await submitLogin(sessions, password, '192.0.2.10', '/superadmin');
  assert.equal(passwordResponse.status, 302);
  assert.equal(passwordResponse.headers.get('location'), '/auth/2fa');
  const challengeCookie = cookiePair(passwordResponse.headers.get('set-cookie'), 'orvex_mfa_challenge');
  assert.ok(challengeCookie);
  assert.doesNotMatch(passwordResponse.headers.get('set-cookie') ?? '', /orvex_session=/);

  const mfaResponse = await sessions.request('/auth/2fa', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: challengeCookie,
      'x-real-ip': '192.0.2.10',
    },
    body: new URLSearchParams({ code: recoveryCode }),
  });
  assert.equal(mfaResponse.status, 302);
  assert.equal(mfaResponse.headers.get('location'), '/superadmin');
  let activeSessionCookie = cookiePair(mfaResponse.headers.get('set-cookie'), 'orvex_session');
  assert.ok(activeSessionCookie);
  assert.equal(db.getUserSecurity(user.id).recoveryCodeHashes.length, 1, 'recovery code was consumed');

  const admin = superadminRoutes();
  const denied = await admin.request('/superadmin', { headers: { cookie: activeSessionCookie } });
  assert.equal(denied.status, 403);
  db.setUserSuperAdmin(user.id, true);
  const allowed = await admin.request('/superadmin', { headers: { cookie: activeSessionCookie } });
  assert.equal(allowed.status, 200);
  assert.match(await allowed.text(), /Super Admin/);

  const security = securityRoutes();
  const settings = await security.request('/settings/security', { headers: { cookie: activeSessionCookie } });
  assert.equal(settings.status, 200);
  const settingsHtml = await settings.text();
  assert.match(settingsHtml, /two-factor authentication is enabled/i);
  assert.match(settingsHtml, /id="regen-password"/, 'recovery-code regeneration requires the current password');
  const csrf = settingsHtml.match(/name="csrf" value="([^"]+)"/)?.[1];
  assert.ok(csrf);

  const disabled = await security.request('/settings/security/totp/disable', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: activeSessionCookie },
    body: new URLSearchParams({
      csrf,
      password,
      code: disableRecoveryCode,
    }),
  });
  assert.equal(disabled.status, 302);
  assert.equal(disabled.headers.get('location'), '/settings/security?disabled=1');
  assert.equal(db.getUserSecurity(user.id).totpEnabled, false);
  const sessionBeforeDisable = cookieValue(activeSessionCookie);
  activeSessionCookie = cookiePair(disabled.headers.get('set-cookie'), 'orvex_session');
  assert.ok(activeSessionCookie, 'disabling MFA rotates the current session');
  assert.equal(db.getSessionUser(sessionBeforeDisable), null);

  const disabledSettings = await security.request('/settings/security', { headers: { cookie: activeSessionCookie } });
  const disabledHtml = await disabledSettings.text();
  const setupCsrf = disabledHtml.match(/name="csrf" value="([^"]+)"/)?.[1];
  assert.ok(setupCsrf);
  const start = await security.request('/settings/security/totp/start', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: activeSessionCookie },
    body: new URLSearchParams({ csrf: setupCsrf }),
  });
  assert.equal(start.status, 302);
  assert.equal(start.headers.get('location'), '/settings/security/totp/setup');
  assert.equal(db.getUserSecurity(user.id).totpEnabled, false, 'starting enrollment does not enable MFA');

  const setup = await security.request('/settings/security/totp/setup', { headers: { cookie: activeSessionCookie } });
  assert.equal(setup.status, 200);
  const setupHtml = await setup.text();
  assert.match(setupHtml, /data:image\/png;base64,/);
  assert.match(setupHtml, /Verify and enable/);
  assert.match(setupHtml, /Current password/);
  const verifyCsrf = setupHtml.match(/name="csrf" value="([^"]+)"/)?.[1];
  assert.ok(verifyCsrf);
  const pendingEncrypted = db.getUserSecurity(user.id).totpSecretEncrypted;
  const pendingSecret = pendingEncrypted
    ? decryptTotpSecret(pendingEncrypted, process.env.PLATFORM_SECRET)
    : null;
  assert.ok(pendingSecret);
  const enrollmentToken = await generate({ secret: pendingSecret });

  const missingPassword = await security.request('/settings/security/totp/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: activeSessionCookie },
    body: new URLSearchParams({ csrf: verifyCsrf, code: enrollmentToken }),
  });
  assert.equal(missingPassword.status, 302);
  assert.equal(db.getUserSecurity(user.id).totpEnabled, false, 'MFA cannot be enabled from only a stolen session');

  const stolenSession = db.createSession(user.id);
  const sessionBeforeEnable = cookieValue(activeSessionCookie);
  const enabled = await security.request('/settings/security/totp/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: activeSessionCookie },
    body: new URLSearchParams({ csrf: verifyCsrf, password, code: enrollmentToken }),
  });
  assert.equal(enabled.status, 200);
  assert.match(await enabled.text(), /Save your recovery codes/);
  assert.equal(db.getUserSecurity(user.id).totpEnabled, true);
  activeSessionCookie = cookiePair(enabled.headers.get('set-cookie'), 'orvex_session');
  assert.ok(activeSessionCookie, 'enabling MFA rotates the current session');
  assert.equal(db.getSessionUser(sessionBeforeEnable), null);
  assert.equal(db.getSessionUser(stolenSession.id), null, 'enabling MFA revokes other sessions');

  const enrollmentReplayChallenge = await loginForMfa(sessions, password);
  const enrollmentReplay = await sessions.request('/auth/2fa', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: enrollmentReplayChallenge, 'x-real-ip': '192.0.2.11' },
    body: new URLSearchParams({ code: enrollmentToken }),
  });
  assert.equal(enrollmentReplay.status, 302);
  assert.equal(enrollmentReplay.headers.get('location'), '/auth/2fa?error=1');

  const freshToken = await generate({ secret: pendingSecret, epoch: Math.floor(Date.now() / 1000) + 30 });
  const firstChallenge = await loginForMfa(sessions, password);
  const accepted = await sessions.request('/auth/2fa', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: firstChallenge, 'x-real-ip': '192.0.2.11' },
    body: new URLSearchParams({ code: freshToken }),
  });
  assert.equal(accepted.status, 302);
  const acceptedSessionCookie = cookiePair(accepted.headers.get('set-cookie'), 'orvex_session');
  assert.ok(acceptedSessionCookie);
  const logoutConfirmation = await sessions.request('/auth/logout', {
    headers: { cookie: acceptedSessionCookie, 'sec-fetch-site': 'cross-site' },
  });
  assert.equal(logoutConfirmation.status, 200);
  const logoutCsrf = (await logoutConfirmation.text()).match(/name="csrf" value="([^"]+)"/)?.[1];
  assert.ok(logoutCsrf);
  assert.ok(db.getSessionUser(cookieValue(acceptedSessionCookie)), 'GET cannot force logout');

  const csrfDeniedLogout = await sessions.request('/auth/logout', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: acceptedSessionCookie },
    body: new URLSearchParams({ csrf: 'invalid' }),
  });
  assert.equal(csrfDeniedLogout.status, 403);
  assert.ok(db.getSessionUser(cookieValue(acceptedSessionCookie)), 'invalid CSRF cannot sign out');

  const loggedOut = await sessions.request('/auth/logout', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: acceptedSessionCookie },
    body: new URLSearchParams({ csrf: logoutCsrf }),
  });
  assert.equal(loggedOut.status, 302);
  assert.equal(loggedOut.headers.get('location'), '/connect');
  assert.equal(db.getSessionUser(cookieValue(acceptedSessionCookie)), null, 'valid POST signs out');

  const replayChallenge = await loginForMfa(sessions, password);
  const replay = await sessions.request('/auth/2fa', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: replayChallenge, 'x-real-ip': '192.0.2.11' },
    body: new URLSearchParams({ code: freshToken }),
  });
  assert.equal(replay.status, 302);
  assert.equal(replay.headers.get('location'), '/auth/2fa?error=1');
  assert.doesNotMatch(replay.headers.get('set-cookie') ?? '', /orvex_session=/);

  db.clearMfaAttempts(user.id);
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const cookie = await loginForMfa(sessions, password);
    const response = await sessions.request('/auth/2fa', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie, 'x-real-ip': '192.0.2.12' },
      body: new URLSearchParams({ code: 'not-a-code' }),
    });
    assert.equal(response.status, attempt <= 5 ? 302 : 429, `attempt ${attempt}`);
  }

  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const response = await submitLogin(sessions, 'wrong-password', `198.51.100.${attempt}`, '/superadmin');
    assert.equal(response.status, attempt <= 5 ? 302 : 429, `distributed password attempt ${attempt}`);
  }
});

async function loginForMfa(app: ReturnType<(typeof import('./session.js'))['sessionRoutes']>, password: string): Promise<string> {
  const response = await submitLogin(app, password, '192.0.2.12', '/superadmin');
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/auth/2fa');
  const cookie = cookiePair(response.headers.get('set-cookie'), 'orvex_mfa_challenge');
  assert.ok(cookie);
  return cookie;
}

async function submitLogin(
  app: ReturnType<(typeof import('./session.js'))['sessionRoutes']>,
  password: string,
  ip: string,
  next: string,
): Promise<Response> {
  const page = await app.request(`/auth/login?next=${encodeURIComponent(next)}`, {
    headers: { 'x-real-ip': ip },
  });
  assert.equal(page.status, 200);
  const csrf = (await page.text()).match(/name="csrf" value="([^"]+)"/)?.[1];
  const csrfCookie = cookiePair(page.headers.get('set-cookie'), 'orvex_login_csrf');
  assert.ok(csrf && csrfCookie);
  return app.request('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: csrfCookie, 'x-real-ip': ip },
    body: new URLSearchParams({ email: 'admin@example.test', password, next, csrf }),
  });
}

function cookiePair(header: string | null, name: string): string {
  const match = header?.match(new RegExp(`(?:^|,\\s*)${name}=([^;]+)`));
  return match ? `${name}=${match[1]}` : '';
}

function cookieValue(cookie: string): string {
  return cookie.slice(cookie.indexOf('=') + 1);
}
