import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INITIAL_BACKOFF_STATE, nextBackoffState, isPaused } from './backoff.js';

const OPTS = { threshold: 3, backoffMs: 300_000 };

test('trips the breaker after N consecutive transient failures, not before', () => {
  let s = INITIAL_BACKOFF_STATE;
  const t0 = 1_000_000;
  s = nextBackoffState(s, 'transient_failure', t0, OPTS);
  assert.equal(isPaused(s, t0), false, '1st failure does not pause');
  s = nextBackoffState(s, 'transient_failure', t0 + 1, OPTS);
  assert.equal(isPaused(s, t0 + 1), false, '2nd failure does not pause');
  s = nextBackoffState(s, 'transient_failure', t0 + 2, OPTS);
  assert.equal(isPaused(s, t0 + 2), true, '3rd consecutive failure trips the breaker');
});

test('a success resets the streak — an isolated blip never trips it', () => {
  let s = INITIAL_BACKOFF_STATE;
  const t0 = 1_000_000;
  s = nextBackoffState(s, 'transient_failure', t0, OPTS);
  s = nextBackoffState(s, 'transient_failure', t0 + 1, OPTS);
  s = nextBackoffState(s, 'success', t0 + 2, OPTS); // resets
  s = nextBackoffState(s, 'transient_failure', t0 + 3, OPTS);
  assert.equal(s.consecutiveFailures, 1, 'streak restarted after the success');
  assert.equal(isPaused(s, t0 + 3), false);
});

test('a non-provider failure (a real bug, not rate-limit/quota) does NOT trip the breaker', () => {
  let s = INITIAL_BACKOFF_STATE;
  const t0 = 1_000_000;
  for (let i = 0; i < 10; i++) {
    s = nextBackoffState(s, 'other_failure', t0 + i, OPTS);
  }
  assert.equal(s.consecutiveFailures, 0);
  assert.equal(
    isPaused(s, t0 + 10),
    false,
    'repeated genuine bugs must not silence the whole worker',
  );
});

test('the pause expires after backoffMs and the pump resumes', () => {
  let s = INITIAL_BACKOFF_STATE;
  const t0 = 1_000_000;
  for (let i = 0; i < 3; i++) s = nextBackoffState(s, 'transient_failure', t0 + i, OPTS);
  assert.equal(isPaused(s, t0 + 3), true);
  assert.equal(
    isPaused(s, t0 + 3 + OPTS.backoffMs + 1),
    false,
    'unpauses once backoffMs has elapsed',
  );
});

test('once paused, further transient failures extend/refresh the pause window', () => {
  let s = INITIAL_BACKOFF_STATE;
  const t0 = 1_000_000;
  for (let i = 0; i < 3; i++) s = nextBackoffState(s, 'transient_failure', t0 + i, OPTS);
  const firstPause = s.pausedUntil;
  s = nextBackoffState(s, 'transient_failure', t0 + 4, OPTS);
  assert.ok(
    s.pausedUntil > firstPause,
    'still-failing provider keeps the breaker tripped, not stuck on the first window',
  );
});
