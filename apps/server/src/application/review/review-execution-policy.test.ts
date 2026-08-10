import assert from 'node:assert/strict';
import { test } from 'node:test';
import { takeReviewCallsByPriority } from './review-execution-policy.js';

test('call budget never removes required complete-coverage calls', () => {
  const required = ['flash-deep-chunk-1', 'flash-deep-chunk-2', 'minimax-chunk-1'];
  const optional = ['risk-hunt', 'sweep'];

  assert.deepEqual(takeReviewCallsByPriority(required, optional, 1), required);
  assert.deepEqual(takeReviewCallsByPriority(required, optional, 4), [...required, 'risk-hunt']);
});
