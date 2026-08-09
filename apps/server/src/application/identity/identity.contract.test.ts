import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import type { OAuthProviderAdapter } from './oauth.js';
import { AuthorizationService } from './authorization.js';
import { OAuthProviders } from './oauth.js';
import { DurableIdentityRateLimits, identityRateLimitPolicies } from './rate-limits.js';
import { RequestSecurity } from './request-security.js';
import { testServerConfig } from '../../bootstrap/test-config.js';

test('request-security contract matrix preserves redirect, origin, IP, and CSRF boundaries', async () => {
  const security = new RequestSecurity({
    appUrl: 'https://app.example.test',
    platformSecret: 'test-secret',
  });
  const proxiedSecurity = new RequestSecurity({
    appUrl: 'https://app.example.test',
    platformSecret: 'test-secret',
    trustedProxyIps: ['127.0.0.1'],
  });
  assert.deepEqual(
    [undefined, '/dashboard', '//attacker.test', '/\\attacker.test', 'https://attacker.test'].map(
      (next) => security.safeNext(next),
    ),
    ['/dashboard', '/dashboard', '/dashboard', '/dashboard', '/dashboard'],
  );
  assert.equal(security.safeNext('/connect?source=login'), '/connect?source=login');

  const app = new Hono();
  app.get('/request', (c) =>
    c.json({
      sameOrigin: security.sameOrigin(c),
      ip: security.clientIp(c),
    }),
  );
  app.get('/csrf', (c) => c.text(security.issueLoginCsrf(c)));
  app.post('/csrf', (c) =>
    c.text(String(security.validLoginCsrf(c, c.req.header('x-csrf') ?? ''))),
  );

  const trusted = await app.request('/request', {
    headers: { origin: 'https://app.example.test', 'x-forwarded-for': '198.51.100.1, 203.0.113.4' },
  });
  assert.deepEqual(await trusted.json(), { sameOrigin: true, ip: 'unknown' });
  const trustedProxyContext = {
    env: { incoming: { socket: { remoteAddress: '127.0.0.1' } } },
    req: {
      header: (name: string) =>
        name === 'x-forwarded-for' ? '198.51.100.1, 203.0.113.4' : undefined,
    },
  } as unknown as Parameters<RequestSecurity['clientIp']>[0];
  assert.equal(proxiedSecurity.clientIp(trustedProxyContext), '198.51.100.1');
  const untrustedProxyContext = {
    env: { incoming: { socket: { remoteAddress: '203.0.113.4' } } },
    req: { header: (name: string) => (name === 'x-real-ip' ? '198.51.100.1' : undefined) },
  } as unknown as Parameters<RequestSecurity['clientIp']>[0];
  assert.equal(proxiedSecurity.clientIp(untrustedProxyContext), '203.0.113.4');
  const untrusted = await app.request('/request', { headers: { origin: 'https://attacker.test' } });
  assert.equal(((await untrusted.json()) as { sameOrigin: boolean }).sameOrigin, false);

  const issued = await app.request('/csrf');
  const token = await issued.text();
  const cookie = issued.headers.get('set-cookie')?.match(/orvex_login_csrf=([^;]+)/)?.[1];
  assert.ok(cookie);
  const accepted = await app.request('/csrf', {
    method: 'POST',
    headers: { cookie: `orvex_login_csrf=${cookie}`, 'x-csrf': token },
  });
  assert.equal(await accepted.text(), 'true');
  const rejected = await app.request('/csrf', {
    method: 'POST',
    headers: { cookie: `orvex_login_csrf=${cookie}`, 'x-csrf': 'wrong' },
  });
  assert.equal(await rejected.text(), 'false');
});

test('durable identity policy matrix names every browser-account budget and does not store raw emails', () => {
  const policies = identityRateLimitPolicies({
    ORVEX_LOGIN_RATE_WINDOW_MS: '1000',
    ORVEX_LOGIN_RATE_IP_MAX: '9',
    ORVEX_REGISTER_RATE_EMAIL_MAX: '2',
  });
  assert.deepEqual(Object.keys(policies).sort(), [
    'login_account',
    'login_ip',
    'mfa_account',
    'mfa_ip',
    'registration_account',
    'registration_ip',
    'security_account',
    'security_ip',
  ]);
  assert.deepEqual(policies.login_ip, { name: 'login_ip', windowMs: 1000, max: 9 });
  assert.equal(policies.registration_account.max, 2);

  const calls: string[] = [];
  const store = {
    consumeAuthAttempt(key: string) {
      calls.push(key);
      return { allowed: true, retryAfterSeconds: 0 };
    },
    clearAuthAttempts(key: string) {
      calls.push(`clear:${key}`);
    },
    consumeMfaAttempt(key: string) {
      calls.push(`mfa:${key}`);
      return { allowed: true, retryAfterSeconds: 0 };
    },
    clearMfaAttempts(key: string) {
      calls.push(`clear-mfa:${key}`);
    },
  };
  const limits = new DurableIdentityRateLimits(store, identityRateLimitPolicies({}));
  const accountKey = limits.accountKey('login', 'member@example.test');
  assert.match(accountKey, /^login:account:[a-f0-9]{64}$/);
  assert.doesNotMatch(accountKey, /member@example/);
  limits.consume('login_account', accountKey);
  limits.consumeMfaAccount('user-1');
  assert.deepEqual(calls, [accountKey, 'mfa:user-1']);
});

test('OAuth provider adapter and capability matrices remain explicit', async () => {
  const github: OAuthProviderAdapter = {
    provider: 'github',
    configured: () => true,
    authorizationUrl: (_redirect, state) =>
      `https://oauth.example.test/github?state=${encodeURIComponent(state)}`,
    exchange: async () => ({ provider: 'github', profile: { githubId: 1, login: 'member' } }),
  };
  const google: OAuthProviderAdapter = {
    provider: 'google',
    configured: () => false,
    authorizationUrl: () => null,
    exchange: async () => ({
      provider: 'google',
      profile: { googleId: '1', email: 'member@example.test' },
    }),
  };
  const providers = new OAuthProviders({ github, google });
  assert.deepEqual(providers.options(), { github: true, google: false });
  assert.match(
    providers.get('github').authorizationUrl('https://app.example.test/callback', 'state') ?? '',
    /state=state/,
  );
  assert.equal(
    (await providers.get('github').exchange('code', 'https://app.example.test/callback')).provider,
    'github',
  );

  const authorizer = new AuthorizationService({} as never, testServerConfig());
  const owner = {
    tenant: {} as never,
    role: 'owner' as const,
    user: { isSuperAdmin: false } as never,
  };
  const member = {
    tenant: {} as never,
    role: 'member' as const,
    user: { isSuperAdmin: false } as never,
  };
  assert.equal(authorizer.allows(owner, 'workspace:read'), true);
  assert.equal(authorizer.allows(owner, 'workspace:manage'), true);
  assert.equal(authorizer.allows(member, 'workspace:manage'), false);
});
