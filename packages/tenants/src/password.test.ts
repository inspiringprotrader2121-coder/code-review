import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { hashPassword, verifyPassword } from './password.js';
import { signOAuthState, verifyOAuthState } from './user-auth.js';

test('password hashing round-trips and rejects wrong password', () => {
  const password = 'Test-only-password-42!';
  const hash = hashPassword(password);
  assert.match(hash, /^scrypt\$[0-9a-f]+\$[0-9a-f]+$/);
  assert.equal(verifyPassword(password, hash), true);
  assert.equal(verifyPassword('wrong', hash), false);
  assert.equal(verifyPassword(password, null), false);
  assert.equal(verifyPassword('x', 'garbage'), false);
});

test('OAuth state is browser-bound by a nonce', () => {
  const state = signOAuthState({ ts: Date.now(), next: '/dashboard', nonce: 'n'.repeat(32) }, 'test-secret');
  assert.equal(verifyOAuthState(state, 'test-secret')?.nonce, 'n'.repeat(32));
  const legacyBody = Buffer.from(JSON.stringify({ ts: Date.now(), next: '/dashboard' })).toString('base64url');
  const legacySig = createHmac('sha256', 'test-secret').update(`oauth.${legacyBody}`).digest('base64url');
  const legacy = `${legacyBody}.${legacySig}`;
  assert.equal(verifyOAuthState(legacy, 'test-secret'), null);
});
