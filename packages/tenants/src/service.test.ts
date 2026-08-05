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

test('does NOT block when the other tenant has no members (webhook orphan reclaim)', async () => {
  // Webhook may create memberless org-* and bind the install first; the signed
  // callback must be allowed to move it onto the connect-flow workspace.
  // Guard passes (tenantHasMembers=false) → proceeds to fetchInstallationMeta
  // (network), which we force as a NON-WorkspaceAccessError so we can tell the
  // guard let it through. Slug-claim of org-* stays blocked in startConnect.
  const svc = new TenantService(mockDb({ tenantHasMembers: () => false }));
  await assert.rejects(
    () => svc.completeInstallCallback(1, 'owner-slug', {} as never),
    (e) => !(e instanceof WorkspaceAccessError),
  );
});

test('does NOT block a same-tenant reinstall', async () => {
  const svc = new TenantService(mockDb({ getInstallation: () => ({ installationId: 1, tenantId: 'tenant-B' }) }));
  await assert.rejects(
    () => svc.completeInstallCallback(1, 'same-slug', {} as never),
    (e) => !(e instanceof WorkspaceAccessError),
  );
});

test('a workspace that OWNS AN INSTALLATION is not claimable by slug', () => {
  // The webhook auto-creates member-less tenants named `org-<accountLogin>`
  // that own a live installation. Treating "no members" as claimable let any
  // signed-in user take over another org's workspace by guessing that slug —
  // gaining private findings and, via autoApply, write access to their repos.
  let granted = false;
  const svc = new TenantService(
    mockDb({
      getTenantBySlug: (slug: string) => ({ id: 'victim', slug, name: slug }),
      getMembership: () => undefined,
      tenantIsClaimable: () => false, // has no members BUT owns an installation
      addWorkspaceMember: () => {
        granted = true;
      },
    }),
  );
  assert.throws(
    () => svc.startConnect('org-victimcorp', 'attacker-user'),
    (e) => e instanceof WorkspaceAccessError && /already taken/i.test((e as Error).message),
  );
  assert.equal(granted, false, 'no membership may be granted on a refused claim');
});

test('a genuinely orphaned workspace (no members, no installation) stays claimable', () => {
  let grantedRole: string | undefined;
  const svc = new TenantService(
    mockDb({
      getTenantBySlug: (slug: string) => ({ id: 'orphan', slug, name: slug }),
      getMembership: () => undefined,
      tenantIsClaimable: () => true,
      addWorkspaceMember: (_t: string, _u: string, role: string) => {
        grantedRole = role;
      },
    }),
  );
  // Same pattern as the rebind test above: the guard passing means we proceed
  // to buildGitHubInstallUrl, which needs real GitHub config. A
  // NON-WorkspaceAccessError therefore proves the claim was allowed through.
  assert.throws(
    () => svc.startConnect('legacy-orphan', 'first-user'),
    (e) => !(e instanceof WorkspaceAccessError),
    'an orphan with no installation must still be claimable',
  );
  assert.equal(grantedRole, 'owner', 'legacy reclaim still grants ownership');
});
