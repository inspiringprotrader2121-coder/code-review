import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { apiRoutes } from './api.js';
import { testAppDatabase, testServerConfig } from '../bootstrap/test-config.js';

test('workspace APIs isolate tenants and reject revoked sessions', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'orvex-launch-security-'));
  const previousStore = process.env.STORE_PATH;
  const previousSecret = process.env.PLATFORM_SECRET;
  const previousLogin = process.env.ORVEX_REQUIRE_LOGIN;
  process.env.STORE_PATH = path.join(dir, 'app.db');
  process.env.PLATFORM_SECRET = 'test-platform-secret-that-is-not-used-in-production';
  process.env.ORVEX_REQUIRE_LOGIN = '1';
  t.after(() => {
    if (previousStore === undefined) delete process.env.STORE_PATH;
    else process.env.STORE_PATH = previousStore;
    if (previousSecret === undefined) delete process.env.PLATFORM_SECRET;
    else process.env.PLATFORM_SECRET = previousSecret;
    if (previousLogin === undefined) delete process.env.ORVEX_REQUIRE_LOGIN;
    else process.env.ORVEX_REQUIRE_LOGIN = previousLogin;
    rmSync(dir, { recursive: true, force: true });
  });

  const db = testAppDatabase();
  const config = testServerConfig();
  const alpha = db.createTenant('alpha');
  const beta = db.createTenant('beta');
  const alphaUser = db.createPasswordUser({ email: 'alpha@example.test', passwordHash: 'unused' })!;
  const betaUser = db.createPasswordUser({ email: 'beta@example.test', passwordHash: 'unused' })!;
  db.addWorkspaceMember(alpha.id, alphaUser.id, 'owner');
  db.addWorkspaceMember(beta.id, betaUser.id, 'owner');
  const alphaSession = db.createSession(alphaUser.id);
  const betaSession = db.createSession(betaUser.id);
  const app = apiRoutes({ db, config });

  assert.equal((await app.request('/api/workspaces/alpha/stats')).status, 401);
  const own = await app.request('/api/workspaces/alpha/stats', {
    headers: { cookie: `orvex_session=${alphaSession.id}` },
  });
  assert.equal(own.status, 200);
  const ownBody = (await own.json()) as { workspace?: string };
  assert.equal(ownBody.workspace, 'alpha');

  const crossTenant = await app.request('/api/workspaces/beta/stats', {
    headers: { cookie: `orvex_session=${alphaSession.id}` },
  });
  assert.equal(crossTenant.status, 403);
  assert.doesNotMatch(await crossTenant.text(), /beta@example|betaUser/i);

  const betaOwn = await app.request('/api/workspaces/beta/stats', {
    headers: { cookie: `orvex_session=${betaSession.id}` },
  });
  assert.equal(betaOwn.status, 200);

  db.deleteSession(alphaSession.id);
  assert.equal(
    (
      await app.request('/api/workspaces/alpha/stats', {
        headers: { cookie: `orvex_session=${alphaSession.id}` },
      })
    ).status,
    401,
  );
});
