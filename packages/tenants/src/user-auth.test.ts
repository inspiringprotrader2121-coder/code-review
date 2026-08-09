import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTenantRuntimeConfig } from './config.js';
import {
  authDisabled,
  legacyAuthMode,
  loadGoogleOAuthConfigFromEnv,
  loadOAuthConfigFromEnv,
} from './user-auth.js';

test('OAuth and authentication decisions use the injected tenant configuration', () => {
  const github = loadTenantRuntimeConfig({
    GITHUB_OAUTH_CLIENT_ID: 'github-id',
    GITHUB_OAUTH_CLIENT_SECRET: 'github-secret',
  });
  assert.deepEqual(loadOAuthConfigFromEnv(github), {
    clientId: 'github-id',
    clientSecret: 'github-secret',
  });
  assert.equal(legacyAuthMode(false, github), false);

  const google = loadTenantRuntimeConfig({
    GOOGLE_OAUTH_CLIENT_ID: 'google-id',
    GOOGLE_OAUTH_CLIENT_SECRET: 'google-secret',
  });
  assert.deepEqual(loadGoogleOAuthConfigFromEnv(google), {
    clientId: 'google-id',
    clientSecret: 'google-secret',
  });

  const disabled = loadTenantRuntimeConfig({ AUTH_DISABLED: '1' });
  assert.equal(authDisabled(disabled), true);
  assert.equal(legacyAuthMode(false, disabled), false);
  assert.equal(legacyAuthMode(false, loadTenantRuntimeConfig({ ORVEX_REQUIRE_LOGIN: '1' })), false);
  assert.equal(legacyAuthMode(true, loadTenantRuntimeConfig({})), false);
  assert.equal(legacyAuthMode(false, loadTenantRuntimeConfig({})), true);
});
