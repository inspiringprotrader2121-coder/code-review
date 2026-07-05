import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TenantService, WorkspaceAccessError } from './service.js';

/** Minimal db stub — only the methods completeInstallCallback touches. */
function mockDb(over: Record<string, unknown> = {}) {
  return {
    getOrCreateTenant: (slug: string) => ({ id: 'tenant-B', slug, name: slug }),
    getInstallation: () => ({ installationId: 1, tenantId: 'tenant-A' }),
    tenantHasMembers: () => true,
    upsertInstallation: () => {
      throw new Error('SECURITY: reached upsert — the guard failed to block the rebind');
    },
    ...over,
  } as unknown as ConstructorParameters<typeof TenantService>[0];
}

test('refuses to rebind an installation owned by another tenant with members (takeover blocked)', async () => {
  const svc = new TenantService(mockDb());
  await assert.rejects(
    // config passed so it never calls loadGitHubConfigFromEnv / the network
    () => svc.completeInstallCallback(1, 'attacker-slug', {} as never),
    (e) => e instanceof WorkspaceAccessError && /already linked to another workspace/.test((e as Error).message),
  );
});

test('does NOT block when the other tenant has no members (orphan reclaim allowed past the guard)', async () => {
  // guard passes (tenantHasMembers=false) → proceeds to fetchInstallationMeta (network),
  // which we force to surface as a NON-WorkspaceAccessError so we can tell the guard let it through.
  const svc = new TenantService(mockDb({ tenantHasMembers: () => false }));
  await assert.rejects(
    () => svc.completeInstallCallback(1, 'owner-slug', {} as never),
    (e) => !(e instanceof WorkspaceAccessError), // failed later (network), not at the guard
  );
});

test('does NOT block a same-tenant reinstall', async () => {
  const svc = new TenantService(mockDb({ getInstallation: () => ({ installationId: 1, tenantId: 'tenant-B' }) }));
  await assert.rejects(
    () => svc.completeInstallCallback(1, 'same-slug', {} as never),
    (e) => !(e instanceof WorkspaceAccessError),
  );
});
