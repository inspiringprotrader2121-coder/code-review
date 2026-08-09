import assert from 'node:assert/strict';
import test from 'node:test';
import { AuthorizationService, type Capability } from './authorization.js';
import { testServerConfig } from '../../bootstrap/test-config.js';

test('golden authorization capability matrix distinguishes members, owners, and superadmins', () => {
  const authorizer = new AuthorizationService({} as never, testServerConfig());
  const capabilities: readonly Capability[] = [
    'workspace:read',
    'workspace:manage',
    'identity:manage',
    'superadmin:read',
    'superadmin:manage',
  ];
  const cases = [
    {
      name: 'member',
      role: 'member' as const,
      user: { isSuperAdmin: false },
      allowed: [true, false, true, false, false],
    },
    {
      name: 'owner',
      role: 'owner' as const,
      user: { isSuperAdmin: false },
      allowed: [true, true, true, false, false],
    },
    {
      name: 'superadmin',
      role: 'owner' as const,
      user: { isSuperAdmin: true },
      allowed: [true, true, true, true, true],
    },
    {
      name: 'legacy owner',
      role: 'owner' as const,
      user: null,
      allowed: [true, true, false, false, false],
    },
  ] as const;
  for (const entry of cases) {
    const subject = { tenant: {} as never, role: entry.role, user: entry.user as never };
    assert.deepEqual(
      capabilities.map((capability) => authorizer.allows(subject, capability)),
      entry.allowed,
      entry.name,
    );
  }
});
