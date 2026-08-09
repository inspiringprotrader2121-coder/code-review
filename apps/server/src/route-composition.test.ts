import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryReviewQueue } from '@orvex-review/queue';
import { AppDatabase } from '@orvex-review/store';
import { createApp } from './app.js';
import { testServerConfig } from './bootstrap/test-config.js';

test('the composition root shares its database with dashboard and API routes', async (t) => {
  const previous = new Map([
    ['AUTH_DISABLED', process.env.AUTH_DISABLED],
    ['ORVEX_REQUIRE_LOGIN', process.env.ORVEX_REQUIRE_LOGIN],
    ['GITHUB_OAUTH_CLIENT_ID', process.env.GITHUB_OAUTH_CLIENT_ID],
    ['GITHUB_OAUTH_CLIENT_SECRET', process.env.GITHUB_OAUTH_CLIENT_SECRET],
    ['GOOGLE_OAUTH_CLIENT_ID', process.env.GOOGLE_OAUTH_CLIENT_ID],
    ['GOOGLE_OAUTH_CLIENT_SECRET', process.env.GOOGLE_OAUTH_CLIENT_SECRET],
  ]);
  for (const key of previous.keys()) delete process.env[key];
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const db = new AppDatabase(':memory:');
  t.after(() => db.close());
  db.createTenant('shared-routes');
  const app = createApp(new MemoryReviewQueue(), { db, config: testServerConfig() });

  const dashboard = await app.request('/dashboard');
  assert.equal(dashboard.status, 302);
  assert.equal(dashboard.headers.get('location'), '/dashboard/shared-routes');

  const reviews = await app.request('/api/workspaces/shared-routes/reviews');
  assert.equal(reviews.status, 200);
  assert.deepEqual(await reviews.json(), {
    workspace: 'shared-routes',
    reviews: [],
  });
});
