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
});
