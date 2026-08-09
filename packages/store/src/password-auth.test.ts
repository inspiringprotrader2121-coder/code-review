import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppDatabase } from './database.js';

test('email/password users: create, find, unique email, hasPasswordUsers', () => {
  const db = new AppDatabase(':memory:');
  assert.equal(db.hasPasswordUsers(), false);

  const u = db.upsertPasswordUser({ email: 'A@Example.com', passwordHash: 'scrypt$aa$bb', name: 'Owner' });
  assert.equal(u.email, 'a@example.com');
  assert.ok(u.githubId < 0, 'synthetic negative github id');
  assert.equal(db.hasPasswordUsers(), true);

  assert.equal(db.getUserByEmail('a@example.com')?.id, u.id);
  assert.equal(db.getUserByEmail('A@EXAMPLE.COM')?.id, u.id, 'case-insensitive');
  assert.equal(db.getPasswordHash(u.id), 'scrypt$aa$bb');

  // upsert updates password, keeps id
  const again = db.upsertPasswordUser({ email: 'a@example.com', passwordHash: 'scrypt$cc$dd' });
  assert.equal(again.id, u.id);
  assert.equal(db.getPasswordHash(u.id), 'scrypt$cc$dd');
  assert.equal(again.isSuperAdmin, false, 'new users are never administrators by default');

  assert.equal(db.setUserSuperAdmin(u.id, true), true);
  assert.equal(db.getUserById(u.id)?.isSuperAdmin, true);

  const originalHash = db.getPasswordHash(u.id);
  assert.equal(
    db.createPasswordUser({ email: 'a@example.com', passwordHash: 'scrypt$changed$hash' }),
    null,
    'registration cannot overwrite an existing password',
  );
  assert.equal(db.getPasswordHash(u.id), originalHash);
});

test('social sign-in links verified provider identities to the existing account', () => {
  const db = new AppDatabase(':memory:');
  const passwordUser = db.createPasswordUser({ email: 'member@example.com', passwordHash: 'hash' });
  assert.ok(passwordUser);
  assert.equal(db.setUserEmailVerified(passwordUser.id), true);

  const googleUser = db.upsertUserFromGoogle({
    googleId: 'google-subject-1',
    email: 'member@example.com',
    name: 'Member',
  });
  assert.equal(googleUser.id, passwordUser.id);
  assert.equal(db.getUserByGoogleId('google-subject-1')?.id, passwordUser.id);

  const githubUser = db.upsertUserFromGitHub({
    githubId: 42,
    login: 'member-gh',
    email: 'member@example.com',
  });
  assert.equal(githubUser.id, passwordUser.id);
  assert.equal(githubUser.githubId, 42);
});

test('OAuth with verified email can claim an unverified password account (no permanent lockout)', () => {
  const db = new AppDatabase(':memory:');
  const passwordUser = db.createPasswordUser({ email: 'unverified@example.com', passwordHash: 'hash' });
  assert.ok(passwordUser);
  // Intentionally do NOT call setUserEmailVerified — signup never verified.
  db.createSession(passwordUser.id);
  assert.equal(db.getPasswordHash(passwordUser.id), 'hash');

  const githubUser = db.upsertUserFromGitHub({
    githubId: 99,
    login: 'unverified-gh',
    email: 'unverified@example.com',
  });
  assert.equal(githubUser.id, passwordUser.id);
  assert.equal(githubUser.githubId, 99);
  assert.equal(db.getPasswordHash(passwordUser.id), null, 'unverified password must be cleared to prevent ATO');
  // password login must fail closed after the claim
  assert.equal(db.getPasswordHash(passwordUser.id) == null, true);

  const googleOnly = db.createPasswordUser({ email: 'unverified-g@example.com', passwordHash: 'hash' });
  assert.ok(googleOnly);
  const googleUser = db.upsertUserFromGoogle({
    googleId: 'google-unverified',
    email: 'unverified-g@example.com',
    name: 'U',
  });
  assert.equal(googleUser.id, googleOnly.id);
  assert.equal(db.getPasswordHash(googleOnly.id), null);
});

test('MFA state is optional, recovery codes are single-use, and challenges expire', () => {
  const db = new AppDatabase(':memory:');
  const user = db.upsertPasswordUser({ email: 'mfa@example.com', passwordHash: 'hash' });
  assert.equal(db.getUserSecurity(user.id).totpEnabled, false);

  assert.equal(db.setPendingTotpSecret(user.id, 'encrypted-secret'), true);
  assert.equal(db.getUserSecurity(user.id).totpEnabled, false, 'enrollment does not enable MFA');
  assert.equal(db.enableTotp(user.id, ['hash-one', 'hash-two']), true);
  assert.equal(db.getUserSecurity(user.id).totpEnabled, true);
  assert.equal(
    db.setPendingTotpSecret(user.id, 'attacker-secret'),
    false,
    'starting enrollment cannot replace an enabled secret',
  );
  assert.equal(db.getUserSecurity(user.id).totpSecretEncrypted, 'encrypted-secret');
  assert.equal(db.consumeRecoveryCode(user.id, 'hash-one'), true);
  assert.equal(db.consumeRecoveryCode(user.id, 'hash-one'), false, 'recovery code cannot be reused');
  assert.deepEqual(db.getUserSecurity(user.id).recoveryCodeHashes, ['hash-two']);

  const challenge = db.createMfaChallenge(user.id, '/superadmin');
  assert.equal(db.getMfaChallenge(challenge.id)?.next, '/superadmin');
  assert.equal(db.consumeMfaChallenge(challenge.id)?.id, challenge.id);
  assert.equal(db.consumeMfaChallenge(challenge.id), null, 'challenge is atomically single-use');
  assert.equal(db.getMfaChallenge(challenge.id), null);

  const expired = db.createMfaChallenge(user.id, '/dashboard', -1);
  assert.equal(db.getMfaChallenge(expired.id), null);

  assert.equal(db.acceptTotpEpoch(user.id, 100), true);
  assert.equal(db.acceptTotpEpoch(user.id, 100), false, 'same TOTP timestep cannot be replayed');
  assert.equal(db.acceptTotpEpoch(user.id, 99), false, 'older TOTP timestep cannot be replayed');
  assert.equal(db.acceptTotpEpoch(user.id, 101), true);

  const atomicChallenge = db.createMfaChallenge(user.id, '/dashboard');
  const atomicResult = db.completeMfaChallenge(atomicChallenge.id, { totpEpoch: 102 });
  assert.equal(atomicResult?.challenge.id, atomicChallenge.id);
  assert.ok(atomicResult?.session.id);
  assert.equal(
    db.completeMfaChallenge(atomicChallenge.id, { totpEpoch: 103 }),
    null,
    'an already-claimed challenge cannot consume another factor',
  );
  assert.equal(db.getUserSecurity(user.id).lastTotpEpoch, 102);

  for (let i = 0; i < 5; i += 1) {
    assert.equal(db.consumeMfaAttempt(user.id, { windowMs: 60_000, max: 5 }, 1_000).allowed, true);
  }
  const blocked = db.consumeMfaAttempt(user.id, { windowMs: 60_000, max: 5 }, 1_000);
  assert.equal(blocked.allowed, false, 'MFA limit is user-wide rather than challenge-wide');
  assert.equal(db.consumeMfaAttempt(user.id, { windowMs: 60_000, max: 5 }, 62_000).allowed, true);
  db.clearMfaAttempts(user.id);

  for (let i = 0; i < 5; i += 1) {
    assert.equal(db.consumeAuthAttempt('login:account:test', { windowMs: 60_000, max: 5 }, 1_000).allowed, true);
  }
  assert.equal(
    db.consumeAuthAttempt('login:account:test', { windowMs: 60_000, max: 5 }, 1_000).allowed,
    false,
    'persistent account limits are independent of client IP',
  );
  db.clearAuthAttempts('login:account:test');

  const firstSession = db.createSession(user.id);
  const secondSession = db.createSession(user.id);
  assert.equal(db.deleteSessionsForUser(user.id), 3);
  assert.equal(db.getSessionUser(atomicResult!.session.id), null);
  assert.equal(db.getSessionUser(firstSession.id), null);
  assert.equal(db.getSessionUser(secondSession.id), null);

  db.disableTotp(user.id);
  assert.equal(db.getUserSecurity(user.id).totpEnabled, false);
});

test('MFA enrollment compare-and-swap and security changes rotate sessions atomically', () => {
  const db = new AppDatabase(':memory:');
  const user = db.upsertPasswordUser({ email: 'atomic@example.com', passwordHash: 'hash' });
  assert.equal(db.setPendingTotpSecret(user.id, 'first-secret'), true);
  assert.equal(db.setPendingTotpSecret(user.id, 'second-secret'), true);

  const stale = db.completeTotpEnrollment({
    userId: user.id,
    expectedEncryptedSecret: 'first-secret',
    totpEpoch: 100,
    recoveryCodeHashes: ['old-code'],
  });
  assert.equal(stale, null, 'a secret replaced during verification cannot be enabled');
  assert.equal(db.getUserSecurity(user.id).totpEnabled, false);

  const oldSession = db.createSession(user.id);
  const enabled = db.completeTotpEnrollment({
    userId: user.id,
    expectedEncryptedSecret: 'second-secret',
    totpEpoch: 100,
    recoveryCodeHashes: ['code-one'],
  });
  assert.ok(enabled);
  assert.equal(db.getSessionUser(oldSession.id), null);
  assert.equal(db.getSessionUser(enabled.id)?.id, user.id);
  assert.equal(db.getUserSecurity(user.id).lastTotpEpoch, 100);

  const replayedRegeneration = db.regenerateRecoveryCodesAndRotateSession({
    userId: user.id,
    totpEpoch: 100,
    recoveryCodeHashes: ['code-two'],
  });
  assert.equal(replayedRegeneration, null, 'settings actions share the TOTP replay ledger');
  assert.deepEqual(db.getUserSecurity(user.id).recoveryCodeHashes, ['code-one']);

  const regenerated = db.regenerateRecoveryCodesAndRotateSession({
    userId: user.id,
    totpEpoch: 101,
    recoveryCodeHashes: ['code-two'],
  });
  assert.ok(regenerated);
  assert.equal(db.getSessionUser(enabled.id), null);
  assert.deepEqual(db.getUserSecurity(user.id).recoveryCodeHashes, ['code-two']);

  const disabled = db.disableTotpAndRotateSession({
    userId: user.id,
    factor: { recoveryCodeHash: 'code-two' },
  });
  assert.ok(disabled);
  assert.equal(db.getSessionUser(regenerated.id), null);
  assert.equal(db.getUserSecurity(user.id).totpEnabled, false);
});
