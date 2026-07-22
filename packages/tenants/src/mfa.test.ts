import assert from 'node:assert/strict';
import test from 'node:test';
import { generate } from 'otplib';
import {
  decryptTotpSecret,
  encryptTotpSecret,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  recoveryCodeMatches,
  totpEnrollmentUri,
  verifyTotpCode,
} from './mfa.js';

test('TOTP enrollment uses an authenticator-compatible URI and accepts a current code', async () => {
  const secret = generateTotpSecret();
  const uri = totpEnrollmentUri('owner@example.com', secret);
  assert.match(uri, /^otpauth:\/\/totp\//);
  assert.match(uri, /issuer=Orvex/);

  const token = await generate({ secret });
  assert.equal(await verifyTotpCode(secret, token), true);
  assert.equal(await verifyTotpCode(secret, '0000000'), false);
});

test('TOTP secrets are authenticated-encrypted and recovery codes are normalized', () => {
  const secret = generateTotpSecret();
  const encrypted = encryptTotpSecret(secret, 'master-secret');
  assert.notEqual(encrypted, secret);
  assert.equal(decryptTotpSecret(encrypted, 'master-secret'), secret);
  assert.equal(decryptTotpSecret(encrypted, 'wrong-secret'), null);

  const codes = generateRecoveryCodes();
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);
  const hash = hashRecoveryCode('user-1', codes[0]!, 'master-secret');
  assert.equal(recoveryCodeMatches(hash, 'user-1', codes[0]!.toLowerCase(), 'master-secret'), true);
  assert.equal(recoveryCodeMatches(hash, 'user-2', codes[0]!, 'master-secret'), false);
});
