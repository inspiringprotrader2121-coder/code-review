import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TenantService, WorkspaceAccessError } from './service.js';

/** Minimal db stub — only the methods completeInstallCallback touches. */
function mockDb(over: Record<string, unknown> = {}) {
  return {
    getOrCreateTenant: (slug: string) => ({ id: 'tenant-B', slug, name: slug }),
    getTenantBySlug: (slug: string) => ({ id: 'tenant-B', slug, name: slug }),
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
    (e) =>
      e instanceof WorkspaceAccessError &&
      /already linked to another workspace/.test((e as Error).message),
  );
});

test('refuses to rebind a memberless webhook row as well', async () => {
  // A webhook-created memberless row is still an installation binding. Moving
  // it based only on a callback installation_id lets an attacker swap IDs.
  const svc = new TenantService(mockDb({ tenantHasMembers: () => false }));
  await assert.rejects(
    () => svc.completeInstallCallback(1, 'owner-slug', {} as never),
    (e) =>
      e instanceof WorkspaceAccessError &&
      /already linked to another workspace/.test((e as Error).message),
  );
});

test('does NOT block a same-tenant reinstall', async () => {
  const svc = new TenantService(
    mockDb({ getInstallation: () => ({ installationId: 1, tenantId: 'tenant-B' }) }),
  );
  await assert.rejects(
    () => svc.completeInstallCallback(1, 'same-slug', {} as never),
    (e) =>
      e instanceof WorkspaceAccessError && /re-authenticate with GitHub/.test((e as Error).message),
  );
});

test('requires user installation proof before binding an unknown installation', async () => {
  const svc = new TenantService(
    mockDb({
      getInstallation: () => null,
    }),
  );
  await assert.rejects(
    () => svc.completeInstallCallback(99, 'new-slug', {} as never),
    (e) =>
      e instanceof WorkspaceAccessError && /re-authenticate with GitHub/.test((e as Error).message),
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

test('tenant status is always membership-scoped', () => {
  const svc = new TenantService(
    mockDb({
      getTenantBySlug: (slug: string) => ({ id: 'tenant-private', slug, name: slug }),
      getMembership: () => null,
    }),
  );
  assert.throws(
    () => svc.getTenantStatusForUser('private', 'unrelated-user'),
    (error) => error instanceof WorkspaceAccessError && /not a member/.test(error.message),
  );
});
