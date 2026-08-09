import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import {
  consumeGitHubInstallProof,
  peekGitHubInstallProof,
  peekOAuthReauthProof,
  setGitHubInstallProof,
  setOAuthReauthProof,
} from './session-proofs.js';

const config = { appUrl: 'https://example.test', platformSecret: 'proof-test-secret' };

test('encrypted GitHub install proof is user-bound, tamper-resistant, and consumed once', async () => {
  const app = new Hono();
  app.get('/set', (c) => {
    setGitHubInstallProof(c, 'user-a', 'github-access-token', config);
    return c.text('ok');
  });
  app.get('/peek', (c) => c.json({ token: peekGitHubInstallProof(c, 'user-a', config) ?? null }));
  app.get('/wrong-user', (c) =>
    c.json({ token: peekGitHubInstallProof(c, 'user-b', config) ?? null }),
  );
  app.get('/consume', (c) =>
    c.json({ token: consumeGitHubInstallProof(c, 'user-a', config) ?? null }),
  );

  const set = await app.request('/set');
  const cookie = cookiePair(set.headers.get('set-cookie'));
  assert.ok(cookie);
  assert.deepEqual(await (await app.request('/peek', { headers: { cookie } })).json(), {
    token: 'github-access-token',
  });
  assert.deepEqual(await (await app.request('/wrong-user', { headers: { cookie } })).json(), {
    token: null,
  });
  const consumed = await app.request('/consume', { headers: { cookie } });
  assert.deepEqual(await consumed.json(), { token: 'github-access-token' });
  const cleared = consumed.headers.get('set-cookie');
  assert.match(cleared ?? '', /orvex_github_install_proof=;/);
  const tampered = `${cookie}x`;
  assert.deepEqual(await (await app.request('/peek', { headers: { cookie: tampered } })).json(), {
    token: null,
  });
});

test('OAuth reauthentication proof accepts only the bound user and a configured provider shape', async () => {
  const app = new Hono();
  app.get('/set', (c) => {
    setOAuthReauthProof(c, 'user-a', 'google', config);
    return c.text('ok');
  });
  app.get('/check', (c) =>
    c.json({ accepted: peekOAuthReauthProof(c, c.req.query('user') ?? '', config) }),
  );
  const set = await app.request('/set');
  const cookie = cookiePair(set.headers.get('set-cookie'));
  assert.deepEqual(
    await (await app.request('/check?user=user-a', { headers: { cookie } })).json(),
    { accepted: true },
  );
  assert.deepEqual(
    await (await app.request('/check?user=user-b', { headers: { cookie } })).json(),
    { accepted: false },
  );
});

function cookiePair(header: string | null): string {
  const match =
    header?.match(/orvex_github_install_proof=([^;]+)/) ??
    header?.match(/orvex_oauth_reauth_proof=([^;]+)/);
  return match ? header!.slice(header!.indexOf(match[0]), header!.indexOf(';')) : '';
}
