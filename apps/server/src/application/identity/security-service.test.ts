import assert from 'node:assert/strict';
import test from 'node:test';
import { generate } from 'otplib';
import { hashPassword } from '@orvex-review/tenants';
import type { AccountSecurityStore } from './security-service.js';
import { AccountSecurityService } from './security-service.js';

const secret = 'test-platform-secret-that-is-long-enough';

test('account security service requires a password or OAuth reauthentication before enrollment', () => {
  const store = fakeStore(null);
  const service = new AccountSecurityService(store, secret);
  assert.deepEqual(service.beginEnrollment('user-1', false), { kind: 'reauth_required' });
  assert.deepEqual(service.beginEnrollment('user-1', true), { kind: 'ok' });
  assert.ok(store.security.totpSecretEncrypted);
});

test('account security service verifies an enrollment and rotates the session through its narrow port', async () => {
  const store = fakeStore(hashPassword('correct-password'));
  const service = new AccountSecurityService(store, secret);
  assert.equal(service.beginEnrollment('user-1', false).kind, 'ok');
  const pending = service.pendingSecret('user-1');
  assert.ok(pending);
  const code = await generate({ secret: pending });
  const result = await service.verifyEnrollment({
    userId: 'user-1',
    password: 'correct-password',
    code,
    oauthReauthenticated: false,
  });
  assert.equal(result.kind, 'ok');
  assert.equal(result.sessionId, 'rotated-session');
  assert.equal(result.recoveryCodes?.length, 10);
  assert.equal(store.security.totpEnabled, true);
});

function fakeStore(passwordHash: string | null): AccountSecurityStore & {
  security: {
    userId: string;
    updatedAt: string;
    totpEnabled: boolean;
    totpSecretEncrypted?: string;
    recoveryCodeHashes: string[];
  };
} {
  const security = {
    userId: 'user-1',
    updatedAt: new Date(0).toISOString(),
    totpEnabled: false,
    totpSecretEncrypted: undefined as string | undefined,
    recoveryCodeHashes: [] as string[],
  };
  return {
    security,
    getPasswordHash: () => passwordHash,
    getUserSecurity: () => security,
    setPendingTotpSecret: (_userId, encryptedSecret) => {
      security.totpSecretEncrypted = encryptedSecret;
      return true;
    },
    completeTotpEnrollment: ({ expectedEncryptedSecret, recoveryCodeHashes }) => {
      if (security.totpSecretEncrypted !== expectedEncryptedSecret) return null;
      security.totpEnabled = true;
      security.recoveryCodeHashes = recoveryCodeHashes;
      return { id: 'rotated-session' } as never;
    },
    disableTotpAndRotateSession: () => null,
    regenerateRecoveryCodesAndRotateSession: () => null,
  };
}
