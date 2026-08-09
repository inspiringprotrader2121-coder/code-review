import assert from 'node:assert/strict';
import test from 'node:test';
import { userCanAccessInstallation } from './install.js';

test('installation proof requires organization admin membership, not visibility alone', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const calls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith('/user')) return Response.json({ login: 'alice' });
    if (url.endsWith('/user/installations/42')) {
      return Response.json({ account: { login: 'acme', type: 'Organization' } });
    }
    return Response.json({ state: 'active', role: 'member' });
  };
  assert.equal(
    await userCanAccessInstallation('token', 42, {
      accountLogin: 'acme',
      accountType: 'Organization',
    }),
    false,
  );
  assert.deepEqual(calls, [
    'https://api.github.com/user',
    'https://api.github.com/user/installations/42',
    'https://api.github.com/orgs/acme/memberships/alice',
  ]);

  calls.length = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith('/user')) return Response.json({ login: 'alice' });
    if (url.endsWith('/user/installations/42')) {
      return Response.json({ account: { login: 'acme', type: 'Organization' } });
    }
    return Response.json({ state: 'active', role: 'admin' });
  };
  assert.equal(
    await userCanAccessInstallation('token', 42, {
      accountLogin: 'acme',
      accountType: 'Organization',
    }),
    true,
  );
});

test('personal installation proof requires the viewer to be the installation owner', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith('/user')) return Response.json({ login: 'alice' });
    return Response.json({ account: { login: 'bob', type: 'User' } });
  };
  assert.equal(
    await userCanAccessInstallation('token', 7, { accountLogin: 'bob', accountType: 'User' }),
    false,
  );
});
