import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isComparableSnapshot } from './competitors.js';

test('only anchored, strict-parser competitor snapshots are comparable', () => {
  assert.equal(
    isComparableSnapshot({
      schemaVersion: 2,
      measurement: {
        kind: 'competitor-coverage',
        headline: 'anchored-inline-only',
        orvexTableParser: 'strict-confirmed-v1',
      },
      prNums: [1],
      pairwise: { all: [], anchored: [] },
    }),
    true,
  );
  assert.equal(isComparableSnapshot({ prNums: [1], pairwise: [] }), false);
});
