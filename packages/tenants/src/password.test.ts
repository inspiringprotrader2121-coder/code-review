import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from './password.js';

test('password hashing round-trips and rejects wrong password', () => {
  const hash = hashPassword('Whoisthesnake21@');
  assert.match(hash, /^scrypt\$[0-9a-f]+\$[0-9a-f]+$/);
  assert.equal(verifyPassword('Whoisthesnake21@', hash), true);
  assert.equal(verifyPassword('wrong', hash), false);
  assert.equal(verifyPassword('Whoisthesnake21@', null), false);
  assert.equal(verifyPassword('x', 'garbage'), false);
});
