import assert from 'node:assert/strict';
import test from 'node:test';
import { mayPublishRuntimeEvidence } from './publication-service.js';

test('golden publication matrix requires a live signal, valid lease, and open PR', async () => {
  const cases = [
    { aborted: false, lease: true, open: true, result: true },
    { aborted: true, lease: true, open: true, result: false },
    { aborted: false, lease: false, open: true, result: false },
    { aborted: false, lease: true, open: false, result: false },
    { aborted: false, lease: true, open: new Error('GitHub unavailable'), result: false },
  ] as const;
  for (const entry of cases) {
    const controller = new AbortController();
    if (entry.aborted) controller.abort();
    assert.equal(
      await mayPublishRuntimeEvidence(
        controller.signal,
        () => entry.lease,
        async () => {
          if (entry.open instanceof Error) throw entry.open;
          return entry.open;
        },
      ),
      entry.result,
    );
  }
});
