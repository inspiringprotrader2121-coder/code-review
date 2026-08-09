import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { verifyPassword } from '@orvex-review/tenants';
import { testAppDatabase, testServerConfig } from '../bootstrap/test-config.js';

test('registration creates a session-bound account and preserves existing passwords', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'orvex-registration-route-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  process.env.STORE_PATH = path.join(dir, 'app.db');
  process.env.PLATFORM_SECRET = 'test-platform-secret-that-is-not-used-in-production';
  process.env.APP_URL = 'https://example.test';
  process.env.ORVEX_REQUIRE_LOGIN = '1';
  process.env.ORVEX_REGISTER_RATE_IP_MAX = '2';

  const { sessionRoutes } = await import('./session.js');
  const db = testAppDatabase();
  const app = sessionRoutes({ db, config: testServerConfig() });

  const missingCsrf = await app.request('/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-real-ip': '192.0.2.30' },
    body: new URLSearchParams({
      email: 'new@example.test',
      password: 'Long-enough-password',
      confirmPassword: 'Long-enough-password',
    }),
  });
  assert.equal(missingCsrf.status, 403);

  const form = await app.request('/auth/register', { headers: { 'x-real-ip': '192.0.2.30' } });
  assert.equal(form.status, 200);
  const formHtml = await form.text();
  assert.match(formHtml, /Create free account/);
  const csrf = formHtml.match(/name="csrf" value="([^"]+)"/)?.[1];
  const csrfCookie = cookiePair(form.headers.get('set-cookie'), 'orvex_login_csrf');
  assert.ok(csrf && csrfCookie);

  const withoutConsent = await app.request('/auth/register', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: csrfCookie,
      'x-real-ip': '192.0.2.30',
    },
    body: new URLSearchParams({
      email: 'new@example.test',
      password: 'Long-enough-password',
      confirmPassword: 'Long-enough-password',
      next: '/connect',
      csrf,
    }),
  });
  assert.equal(withoutConsent.status, 400);
  assert.match(await withoutConsent.text(), /Terms of Service and Privacy Policy/);

  const registered = await app.request('/auth/register', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: csrfCookie,
      'x-real-ip': '192.0.2.30',
    },
    body: new URLSearchParams({
      email: 'new@example.test',
      password: 'Long-enough-password',
      confirmPassword: 'Long-enough-password',
      acceptedTerms: '1',
      next: '/connect',
      csrf,
    }),
  });
  assert.equal(registered.status, 302);
  assert.equal(registered.headers.get('location'), '/connect');
  const user = db.getUserByEmail('new@example.test');
  assert.ok(user);
  assert.ok(verifyPassword('Long-enough-password', db.getPasswordHash(user.id)));
  assert.ok(cookiePair(registered.headers.get('set-cookie'), 'orvex_session'));

  const duplicateForm = await app.request('/auth/register', {
    headers: { 'x-real-ip': '192.0.2.30' },
  });
  const duplicateHtml = await duplicateForm.text();
  const duplicateCsrf = duplicateHtml.match(/name="csrf" value="([^"]+)"/)?.[1];
  const duplicateCookie = cookiePair(duplicateForm.headers.get('set-cookie'), 'orvex_login_csrf');
  assert.ok(duplicateCsrf && duplicateCookie);
  const duplicate = await app.request('/auth/register', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: duplicateCookie,
      'x-real-ip': '192.0.2.30',
    },
    body: new URLSearchParams({
      email: 'new@example.test',
      password: 'Different-long-password',
      confirmPassword: 'Different-long-password',
      acceptedTerms: '1',
      next: '/connect',
      csrf: duplicateCsrf,
    }),
  });
  assert.equal(duplicate.status, 409);
  assert.ok(verifyPassword('Long-enough-password', db.getPasswordHash(user.id)));

  const rateForm = await app.request('/auth/register', { headers: { 'x-real-ip': '192.0.2.30' } });
  const rateHtml = await rateForm.text();
  const rateCsrf = rateHtml.match(/name="csrf" value="([^"]+)"/)?.[1];
  const rateCookie = cookiePair(rateForm.headers.get('set-cookie'), 'orvex_login_csrf');
  assert.ok(rateCsrf && rateCookie);
  const rateLimited = await app.request('/auth/register', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: rateCookie,
      'x-real-ip': '192.0.2.30',
    },
    body: new URLSearchParams({
      email: 'second@example.test',
      password: 'Long-enough-password',
      confirmPassword: 'Long-enough-password',
      acceptedTerms: '1',
      next: '/connect',
      csrf: rateCsrf,
    }),
  });
  assert.equal(rateLimited.status, 429, 'successful signups remain within the IP rate window');
  assert.equal(db.getUserByEmail('second@example.test'), null);
});

function cookiePair(header: string | null, name: string): string {
  const match = header?.match(new RegExp(`(?:^|,\\s*)${name}=([^;]+)`));
  return match ? `${name}=${match[1]}` : '';
}
