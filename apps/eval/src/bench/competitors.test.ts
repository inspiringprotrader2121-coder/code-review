import assert from 'node:assert/strict';
import { test } from 'node:test';
import { coderabbitState, mergeCoderabbitState } from './competitors.js';

test('CodeRabbit billing notices are recorded as rate-limited, not clean reviews', () => {
  assert.equal(
    coderabbitState(
      'Review limit reached. Next review available in: 35 minutes. Enable usage-based reviews to review now.',
    ),
    'rate_limited',
  );
  assert.equal(
    coderabbitState(
      'This review was rate limited by CodeRabbit because adaptive limits are currently applied.',
    ),
    'rate_limited',
  );
});

test('CodeRabbit skip notices remain distinct from rate limits', () => {
  assert.equal(coderabbitState('Review skipped: no new commits to review.'), 'skipped');
  assert.equal(
    coderabbitState('The PR is safe to merge; no concrete defect identified.'),
    'reviewed',
  );
});

test('a rate-limit notice wins over historical review evidence', () => {
  assert.equal(mergeCoderabbitState('reviewed', 'rate_limited'), 'rate_limited');
  assert.equal(mergeCoderabbitState('rate_limited', 'reviewed'), 'rate_limited');
  assert.equal(mergeCoderabbitState('skipped', 'reviewed'), 'reviewed');
});
