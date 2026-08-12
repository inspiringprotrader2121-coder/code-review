import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isGitHubRateLimitError,
  parseGitHubRetryAfterMs,
  withGitHubRetry,
} from './retry.js';
import { MemoryGitHubInstallationPacer } from './pacer.js';

test('parseGitHubRetryAfterMs reads header seconds and message hints', () => {
  assert.equal(
    parseGitHubRetryAfterMs({
      status: 403,
      response: { headers: { 'retry-after': '12' } },
    }),
    12_000,
  );
  assert.equal(parseGitHubRetryAfterMs({ message: 'retry-after: 7' }), 7_000);
});

test('withGitHubRetry waits Retry-After then succeeds without dropping work', async () => {
  let calls = 0;
  const waits: number[] = [];
  const result = await withGitHubRetry(
    async () => {
      calls++;
      if (calls === 1) {
        const error = Object.assign(new Error('API rate limit exceeded'), {
          status: 403,
          response: { headers: { 'retry-after': '0.01' } },
        });
        throw error;
      }
      return 'ok';
    },
    {
      maxWaitMs: 5_000,
      onRetry: (waitMs) => waits.push(waitMs),
    },
  );
  assert.equal(result, 'ok');
  assert.equal(calls, 2);
  assert.equal(waits.length, 1);
  assert.ok(waits[0]! >= 10);
});

test('memory pacer isolates installations and honors Retry-After freeze', async () => {
  const pacer = new MemoryGitHubInstallationPacer({
    tokensPerSecond: 100,
    burst: 1,
    maxWaitMs: 5_000,
  });
  await pacer.acquire(11);
  await pacer.noteRetryAfter?.(11, 80);
  // Sibling installation is unaffected by the freeze.
  await pacer.acquire(22);
  const started = Date.now();
  await pacer.acquire(11);
  assert.ok(Date.now() - started >= 50, 'frozen installation waits out Retry-After');
});
