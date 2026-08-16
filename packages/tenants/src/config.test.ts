import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTenantRuntimeConfig } from './config.js';

test('tenant runtime config snapshots auth, plan, and identity settings immutably', () => {
  const config = loadTenantRuntimeConfig({
    APP_URL: 'https://app.example.test/',
    PLATFORM_SECRET: 'platform',
    GITHUB_OAUTH_CLIENT_ID: 'github-id',
    GITHUB_OAUTH_CLIENT_SECRET: 'github-secret',
    GOOGLE_OAUTH_CLIENT_ID: 'google-id',
    GOOGLE_OAUTH_CLIENT_SECRET: 'google-secret',
    AUTH_DISABLED: '1',
    ORVEX_REQUIRE_LOGIN: '1',
    ORVEX_DEFAULT_PLAN: 'verify',
    ORVEX_EXTRA_DISPOSABLE_DOMAINS: 'Temp.example, extra.example ',
  });

  assert.equal(config.appUrl, 'https://app.example.test');
  assert.equal(config.platformSecret, 'platform');
  assert.deepEqual(config.githubOAuth, { clientId: 'github-id', clientSecret: 'github-secret' });
  assert.deepEqual(config.googleOAuth, { clientId: 'google-id', clientSecret: 'google-secret' });
  assert.equal(config.authDisabled, true);
  assert.equal(config.requireLogin, true);
  assert.equal(config.defaultPlanId, 'verify');
  assert.deepEqual(config.extraDisposableDomains, ['temp.example', 'extra.example']);
  assert.deepEqual(config.unlimitedGithubOwners, []);
  assert.ok(Object.isFrozen(config));
  assert.ok(Object.isFrozen(config.extraDisposableDomains));
  assert.ok(Object.isFrozen(config.githubOAuth));
});

test('tenant runtime config preserves the legacy localhost and optional OAuth defaults', () => {
  const config = loadTenantRuntimeConfig({ PORT: '4567' });
  assert.equal(config.appUrl, 'http://localhost:4567');
  assert.equal(config.githubAppSlug, 'orvex-review');
  assert.equal(config.githubOAuth, null);
  assert.equal(config.googleOAuth, null);
  assert.equal(config.platformSecret, null);
  assert.equal(config.defaultPlanId, null);
});
