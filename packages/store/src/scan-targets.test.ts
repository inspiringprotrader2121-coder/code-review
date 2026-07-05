import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppDatabase } from './database.js';

test('listScanTargets returns enabled repos of active installs, tagged with plan', () => {
  const d = new AppDatabase(':memory:');
  const t = d.createTenant('acme');
  d.setTenantPlan(t.id, 'verify');
  d.upsertInstallation({ installationId: 100, tenantId: t.id, accountLogin: 'acme', accountType: 'Organization' });
  d.upsertRepo({ installationId: 100, tenantId: t.id, githubRepoId: 1, owner: 'acme', name: 'api', fullName: 'acme/api', defaultBranch: 'main' });
  d.upsertRepo({ installationId: 100, tenantId: t.id, githubRepoId: 2, owner: 'acme', name: 'web', fullName: 'acme/web' });

  // disable one repo — it must not be a scan target
  const web = d.listRepos(t.id).find((r) => r.name === 'web')!;
  d.setRepoEnabled(web.id, false);

  const targets = d.listScanTargets();
  assert.equal(targets.length, 1);
  assert.equal(targets[0].name, 'api');
  assert.equal(targets[0].plan, 'verify');
  assert.equal(targets[0].defaultBranch, 'main');
});

test('listScanTargets excludes suspended installations', () => {
  const d = new AppDatabase(':memory:');
  const t = d.createTenant('acme');
  d.setTenantPlan(t.id, 'verify');
  d.upsertInstallation({ installationId: 100, tenantId: t.id, accountLogin: 'acme', accountType: 'Organization' });
  d.upsertRepo({ installationId: 100, tenantId: t.id, githubRepoId: 1, owner: 'acme', name: 'api', fullName: 'acme/api' });
  assert.equal(d.listScanTargets().length, 1);

  d.upsertInstallation({
    installationId: 100,
    tenantId: t.id,
    accountLogin: 'acme',
    accountType: 'Organization',
    suspendedAt: new Date().toISOString(),
  });
  assert.equal(d.listScanTargets().length, 0, 'suspended install is not scanned');
});
