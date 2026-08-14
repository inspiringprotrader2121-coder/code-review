import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryTpmWindow } from './tpm-window.js';

test('TPM window refuses a reserve that would exceed the rolling-minute budget', () => {
  let now = 1_000;
  const window = new InMemoryTpmWindow(() => now);
  const first = window.tryReserve({
    lane: 'deepseek:k0',
    tokens: 1_900_000,
    budget: 2_000_000,
    reservationId: 'r1',
  });
  assert.equal(first.ok, true);
  window.commit({ lane: 'deepseek:k0', reservationId: 'r1', actualTokens: 1_900_000 });
  const blocked = window.tryReserve({
    lane: 'deepseek:k0',
    tokens: 150_000,
    budget: 2_000_000,
    reservationId: 'r2',
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.used, 1_900_000);

  const other = window.tryReserve({
    lane: 'deepseek:k1',
    tokens: 150_000,
    budget: 2_000_000,
    reservationId: 'r3',
  });
  assert.equal(other.ok, true);

  now += 60_001;
  const afterWindow = window.tryReserve({
    lane: 'deepseek:k0',
    tokens: 150_000,
    budget: 2_000_000,
    reservationId: 'r4',
  });
  assert.equal(afterWindow.ok, true);
});
