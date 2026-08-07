import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import { canonicalHostRedirect, productionSecurityHeaders } from './app.js';
import { sameOriginRequest } from './routes/request-security.js';

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

test('redirects the www host to the canonical public host', async (t) => {
  const previousAppUrl = process.env.APP_URL;
  process.env.APP_URL = 'https://useorvex.com';
  t.after(() => {
    if (previousAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = previousAppUrl;
  });

  const app = new Hono();
  app.use('*', productionSecurityHeaders);
  app.use('*', canonicalHostRedirect);
  app.get('/connect', (c) => c.text('connect'));

  const response = await app.request('/connect?next=1', { headers: { host: 'www.useorvex.com' } });
  assert.equal(response.status, 308);
  assert.equal(response.headers.get('location'), 'https://useorvex.com/connect?next=1');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
});

test('same-origin mutation checks fail closed when APP_URL is not configured', async (t) => {
  const previousAppUrl = process.env.APP_URL;
  delete process.env.APP_URL;
  t.after(() => {
    if (previousAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = previousAppUrl;
  });

  const app = new Hono();
  app.post('/mutate', (c) => c.json({ allowed: sameOriginRequest(c) }));
  const response = await app.request('http://attacker.example/mutate', {
    method: 'POST',
    headers: { origin: 'http://attacker.example' },
  });
  assert.deepEqual(await response.json(), { allowed: false });
});
