import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OAuthLoginFlow } from './oauth-login-flow.js';
import { IdentityService } from './identity-service.js';
import { OAuthProviders, type OAuthProviderAdapter } from './oauth.js';
import { testAppDatabase, testServerConfig } from '../../bootstrap/test-config.js';

test('OAuth flow signs state, rejects a substituted reauth identity, and preserves the linked account', async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'orvex-oauth-flow-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const config = testServerConfig({
    STORE_PATH: path.join(directory, 'app.db'),
    PLATFORM_SECRET: 'oauth-flow-test-secret',
  });
  const db = testAppDatabase({
    STORE_PATH: path.join(directory, 'app.db'),
    PLATFORM_SECRET: 'oauth-flow-test-secret',
  });
  const user = db.upsertUserFromGitHub({
    githubId: 42,
    login: 'member',
    email: 'member@example.test',
  });
  const github: OAuthProviderAdapter = {
    provider: 'github',
    configured: () => true,
    authorizationUrl: (_redirect, state) =>
      `https://oauth.example.test/github?state=${encodeURIComponent(state)}`,
    exchange: async () => ({ provider: 'github', profile: { githubId: 99, login: 'substituted' } }),
  };
  const google: OAuthProviderAdapter = {
    provider: 'google',
    configured: () => false,
    authorizationUrl: () => null,
    exchange: async () => {
      throw new Error('unexpected Google exchange');
    },
  };
  const identity = new IdentityService(db, config.platformSecret, true);
  const flow = new OAuthLoginFlow(db, identity, new OAuthProviders({ github, google }), config);
  const nonce = 'n'.repeat(32);
  const location = flow.begin('github', '/settings/security', nonce, 'mfa-proof', user.id);
  assert.ok(location);
  const state = new URL(location!).searchParams.get('state');
  assert.ok(state);
  assert.equal(flow.stateNonce(state!, 'github'), nonce);
  const result = await flow.callback({
    provider: 'github',
    code: 'code',
    state: state!,
    csrfValid: true,
    currentUser: user,
  });
  assert.deepEqual(result, { kind: 'failed', next: '/settings/security' });
  assert.equal(db.getUserByGitHubId(42)?.id, user.id);
  assert.equal(db.getUserByGitHubId(99), null);
});
