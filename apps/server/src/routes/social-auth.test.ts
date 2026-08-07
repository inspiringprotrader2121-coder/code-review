import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('Google and GitHub OAuth sign-in link an existing workspace account and open its dashboard', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'orvex-social-auth-route-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  process.env.STORE_PATH = path.join(dir, 'app.db');
  process.env.PLATFORM_SECRET = 'test-platform-secret-that-is-not-used-in-production';
  process.env.APP_URL = 'https://example.test';
  process.env.ORVEX_REQUIRE_LOGIN = '1';
  process.env.GITHUB_OAUTH_CLIENT_ID = 'github-client';
  process.env.GITHUB_OAUTH_CLIENT_SECRET = 'github-secret';
  process.env.GOOGLE_OAUTH_CLIENT_ID = 'google-client';
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'google-secret';
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const [{ createAppDatabase }, { sessionRoutes }] = await Promise.all([
    import('@orvex-review/store'),
    import('./session.js'),
  ]);
  const db = createAppDatabase();
  const existingUser = db.createPasswordUser({ email: 'member@example.test', passwordHash: 'not-used-in-this-test' });
  assert.ok(existingUser);
  db.setUserEmailVerified(existingUser.id);
  const existingWorkspace = db.createTenant('member-workspace');
  db.addWorkspaceMember(existingWorkspace.id, existingUser.id, 'owner');
  const app = sessionRoutes();
  const login = await app.request('/auth/login?next=/connect');
  const loginHtml = await login.text();
  assert.match(loginHtml, /Continue with Google/);
  assert.match(loginHtml, /Continue with GitHub/);
  const cookie = cookiePair(login.headers.get('set-cookie'), 'orvex_login_csrf');
  assert.ok(cookie);

  const googleStart = await app.request('/auth/google?next=/connect', { headers: { cookie } });
  assert.equal(googleStart.status, 302);
  const googleLocation = new URL(googleStart.headers.get('location')!);
  assert.equal(googleLocation.origin, 'https://accounts.google.com');
  const googleState = googleLocation.searchParams.get('state');
  assert.ok(googleState);

  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'google-token' });
    if (url === 'https://openidconnect.googleapis.com/v1/userinfo') {
      return Response.json({ sub: 'google-subject', email: 'member@example.test', email_verified: true, name: 'Member' });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const googleCallback = await app.request(`/auth/google/callback?code=google-code&state=${encodeURIComponent(googleState)}`, {
    headers: { cookie },
  });
  assert.equal(googleCallback.status, 302);
  assert.equal(googleCallback.headers.get('location'), '/dashboard');
  const googleUser = db.getUserByEmail('member@example.test');
  assert.ok(googleUser);
  assert.equal(googleUser.id, existingUser.id);

  const githubLogin = await app.request('/auth/login?next=/connect');
  const githubCookie = cookiePair(githubLogin.headers.get('set-cookie'), 'orvex_login_csrf');
  const githubStart = await app.request('/auth/github?next=/connect', { headers: { cookie: githubCookie } });
  const githubLocation = new URL(githubStart.headers.get('location')!);
  assert.equal(githubLocation.origin, 'https://github.com');
  const githubState = githubLocation.searchParams.get('state');
  assert.ok(githubState);

  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url === 'https://github.com/login/oauth/access_token') return Response.json({ access_token: 'github-token' });
    if (url === 'https://api.github.com/user') return Response.json({ id: 42, login: 'member-gh', name: 'Member' });
    if (url === 'https://api.github.com/user/emails') {
      return Response.json([{ email: 'member@example.test', primary: true, verified: true }]);
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const githubCallback = await app.request(`/auth/oauth/callback?code=github-code&state=${encodeURIComponent(githubState)}`, {
    headers: { cookie: githubCookie },
  });
  assert.equal(githubCallback.status, 302);
  assert.equal(githubCallback.headers.get('location'), '/dashboard');
  const githubUser = db.getUserByGitHubId(42);
  assert.ok(githubUser);
  assert.equal(githubUser.id, googleUser.id);
});

test('OAuth-only MFA reauthentication must return the already-linked provider identity', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'orvex-mfa-reauth-route-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  process.env.STORE_PATH = path.join(dir, 'app.db');
  process.env.PLATFORM_SECRET = 'test-platform-secret-that-is-not-used-in-production';
  process.env.APP_URL = 'https://example.test';
  process.env.GITHUB_OAUTH_CLIENT_ID = 'github-client';
  process.env.GITHUB_OAUTH_CLIENT_SECRET = 'github-secret';
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const [{ createAppDatabase }, { sessionRoutes }] = await Promise.all([
    import('@orvex-review/store'),
    import('./session.js'),
  ]);
  const db = createAppDatabase();
  const user = db.upsertUserFromGitHub({ githubId: 42, login: 'linked-user', email: 'linked@example.test' });
  const session = db.createSession(user.id);
  const app = sessionRoutes();
  const start = await app.request('/auth/reauth?provider=github&next=/settings/security', {
    headers: { cookie: `orvex_session=${session.id}` },
  });
  assert.equal(start.status, 302);
  const location = new URL(start.headers.get('location')!);
  const state = location.searchParams.get('state');
  assert.ok(state);
  const csrf = cookiePair(start.headers.get('set-cookie'), 'orvex_login_csrf');
  assert.ok(csrf);

  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url === 'https://github.com/login/oauth/access_token') return Response.json({ access_token: 'other-user-token' });
    if (url === 'https://api.github.com/user') return Response.json({ id: 99, login: 'other-user' });
    if (url === 'https://api.github.com/user/emails') return Response.json([]);
    throw new Error(`unexpected fetch ${url}`);
  };
  const callback = await app.request(`/auth/oauth/callback?code=other-code&state=${encodeURIComponent(state)}`, {
    headers: { cookie: `orvex_session=${session.id}; ${csrf}` },
  });
  assert.equal(callback.status, 302);
  assert.equal(new URL(callback.headers.get('location')!, 'https://example.test').pathname, '/auth/login');
  assert.match(callback.headers.get('location')!, /error=github/);
});

test('OAuth-only MFA chooses the linked Google provider when both OAuth providers are configured', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'orvex-google-mfa-route-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  process.env.STORE_PATH = path.join(dir, 'app.db');
  process.env.PLATFORM_SECRET = 'test-platform-secret-that-is-not-used-in-production';
  process.env.APP_URL = 'https://example.test';
  process.env.GITHUB_OAUTH_CLIENT_ID = 'github-client';
  process.env.GITHUB_OAUTH_CLIENT_SECRET = 'github-secret';
  process.env.GOOGLE_OAUTH_CLIENT_ID = 'google-client';
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'google-secret';

  const [{ createAppDatabase }, { sessionRoutes }] = await Promise.all([
    import('@orvex-review/store'),
    import('./session.js'),
  ]);
  const db = createAppDatabase();
  const user = db.upsertUserFromGoogle({
    googleId: 'google-linked',
    email: 'google-only@example.test',
  });
  const session = db.createSession(user.id);
  const app = sessionRoutes();
  const start = await app.request('/auth/reauth?provider=github&next=/settings/security', {
    headers: { cookie: `orvex_session=${session.id}` },
  });
  assert.equal(start.status, 302);
  assert.equal(new URL(start.headers.get('location')!).origin, 'https://accounts.google.com');
});

function cookiePair(header: string | null, name: string): string {
  const match = header?.match(new RegExp(`(?:^|,\\s*)${name}=([^;]+)`));
  return match ? `${name}=${match[1]}` : '';
}
