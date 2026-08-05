import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('only allowlisted tenants receive LLM cost data or dashboard controls', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'orvex-cost-visibility-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const envKeys = [
    'STORE_PATH',
    'ORVEX_LLM_COST_VISIBLE_TENANTS',
    'ORVEX_REQUIRE_LOGIN',
    'AUTH_DISABLED',
    'GITHUB_OAUTH_CLIENT_ID',
    'GITHUB_OAUTH_CLIENT_SECRET',
    'GOOGLE_OAUTH_CLIENT_ID',
    'GOOGLE_OAUTH_CLIENT_SECRET',
  ] as const;
  const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const key of envKeys) {
      const value = originalEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  process.env.STORE_PATH = path.join(dir, 'app.db');
  process.env.ORVEX_LLM_COST_VISIBLE_TENANTS = 'internal-testing';
  delete process.env.ORVEX_REQUIRE_LOGIN;
  delete process.env.AUTH_DISABLED;
  delete process.env.GITHUB_OAUTH_CLIENT_ID;
  delete process.env.GITHUB_OAUTH_CLIENT_SECRET;
  delete process.env.GOOGLE_OAUTH_CLIENT_ID;
  delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;

  const [{ createAppDatabase }, { apiRoutes }, { dashboardRoutes }] = await Promise.all([
    import('@orvex-review/store'),
    import('./api.js'),
    import('./dashboard.js'),
  ]);
  const db = createAppDatabase();
  const internal = db.createTenant('internal-testing');
  const customer = db.createTenant('customer-workspace');
  for (const tenant of [internal, customer]) {
    const runId = db.startReviewRun({
      tenantId: tenant.id,
      installationId: 1,
      owner: tenant.slug,
      repo: 'repo',
      pr: 1,
      headSha: 'abc123',
      action: 'review',
    });
    db.completeReviewRun(runId, { status: 'completed', durationMs: 1_000, costUsd: 0.42 });
  }

  const api = apiRoutes();
  const customerOverview = await json(api, '/api/workspaces/customer-workspace/overview');
  assert.equal('costUsd' in customerOverview.stats, false);
  assert.equal('costUsd' in customerOverview.recentReviews[0], false);
  const customerStats = await json(api, '/api/workspaces/customer-workspace/stats');
  assert.equal('costUsd' in customerStats, false);
  const customerReviews = await json(api, '/api/workspaces/customer-workspace/reviews');
  assert.equal('costUsd' in customerReviews.reviews[0], false);

  const internalOverview = await json(api, '/api/workspaces/internal-testing/overview');
  assert.equal(internalOverview.stats.costUsd, 0.42);
  assert.equal(internalOverview.recentReviews[0].costUsd, 0.42);

  const dashboards = dashboardRoutes();
  const customerDashboard = await dashboards.request('/dashboard/customer-workspace');
  const customerHtml = await customerDashboard.text();
  assert.match(customerHtml, /const SHOW_LLM_COST=false/);
  assert.doesNotMatch(customerHtml, /<th class="r">Cost<\/th>/);
  const billingSuccessDashboard = await dashboards.request('/dashboard/customer-workspace?billing=success');
  assert.match(await billingSuccessDashboard.text(), /Payment received\. Your plan is activating now/);
  const internalDashboard = await dashboards.request('/dashboard/internal-testing');
  const internalHtml = await internalDashboard.text();
  assert.match(internalHtml, /const SHOW_LLM_COST=true/);
  assert.match(internalHtml, /<th class="r">Cost<\/th>/);
});

async function json(app: { request(path: string): Response | Promise<Response> }, path: string): Promise<any> {
  const response = await app.request(path);
  assert.equal(response.status, 200);
  return response.json();
}
