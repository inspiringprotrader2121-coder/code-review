import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import { productionSecurityHeaders } from './app.js';

test('sets browser security headers and keeps authenticated surfaces out of caches', async (t) => {
  const previousAppUrl = process.env.APP_URL;
  process.env.APP_URL = 'https://useorvex.com';
  t.after(() => {
    if (previousAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = previousAppUrl;
  });

  const app = new Hono();
  app.use('*', productionSecurityHeaders);
  app.get('/', (c) => c.html('<h1>public</h1>'));
  app.get('/auth/login', (c) => c.html('<h1>login</h1>'));

  const publicResponse = await app.request('/');
  assert.equal(publicResponse.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(publicResponse.headers.get('x-frame-options'), 'DENY');
  assert.equal(publicResponse.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.equal(publicResponse.headers.get('permissions-policy'), 'camera=(), geolocation=(), microphone=()');
  assert.equal(publicResponse.headers.get('strict-transport-security'), 'max-age=31536000; includeSubDomains');
  assert.match(publicResponse.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
  assert.equal(publicResponse.headers.get('cache-control'), null);

  const loginResponse = await app.request('/auth/login');
  assert.equal(loginResponse.headers.get('cache-control'), 'no-store');
});
