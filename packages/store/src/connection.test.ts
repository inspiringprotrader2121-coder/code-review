import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertDurableStorePath, openSqliteConnection } from './connection.js';

test('SQLite connection centralizes required pragmas', () => {
  const db = openSqliteConnection(':memory:', {
    checkoutRoot: process.cwd(),
    requireDurableStorage: false,
  });
  try {
    assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
    assert.equal(db.pragma('busy_timeout', { simple: true }), 5000);
  } finally {
    db.close();
  }
});

test('durable store path rejects checkout-local database files', () => {
  assert.throws(
    () =>
      assertDurableStorePath(`${process.cwd()}/.data/orvex-review.db`, {
        checkoutRoot: process.cwd(),
        requireDurableStorage: true,
      }),
    /outside the checkout/,
  );
});
