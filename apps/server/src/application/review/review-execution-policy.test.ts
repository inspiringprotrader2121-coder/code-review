import assert from 'node:assert/strict';
import test from 'node:test';
import { resolvePrStatePollMs } from './review-execution-policy.js';

test('GitHub PR-state polling stays quota-safe while ownership heartbeats remain frequent', () => {
  assert.equal(resolvePrStatePollMs(5_000), 30_000);
  assert.equal(resolvePrStatePollMs(60_000), 60_000);
  assert.equal(resolvePrStatePollMs(Number.NaN), 30_000);
});
