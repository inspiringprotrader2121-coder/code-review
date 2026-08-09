import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  activeReviewSignal,
  cancelAllActiveReviews,
  cancelActiveReviewsForPr,
  directorySizeBytes,
  getActiveReviewCount,
  noteActiveCheckoutDir,
  noteActiveChildSpawn,
  runWithActiveReview,
  sampleActiveReviews,
} from './active-reviews.js';
import type { ReviewJobPayload } from '@orvex-review/queue';

function job(partial: Partial<ReviewJobPayload> = {}): ReviewJobPayload {
  return {
    installationId: 1,
    tenantId: 'tenant-a',
    owner: 'acme',
    repo: 'api',
    pr: 42,
    headSha: 'abc123456789',
    action: 'opened',
    kind: 'review',
    enqueuedAt: new Date().toISOString(),
    ...partial,
  };
}

test('directorySizeBytes sums nested files', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'orvex-du-'));
  try {
    mkdirSync(path.join(root, 'sub'));
    writeFileSync(path.join(root, 'a.txt'), 'hello'); // 5
    writeFileSync(path.join(root, 'sub', 'b.txt'), 'world!!'); // 7
    assert.equal(directorySizeBytes(root), 12);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runWithActiveReview exposes one full-review row with checkout disk', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'orvex-active-'));
  try {
    writeFileSync(path.join(root, 'blob.bin'), Buffer.alloc(2048));
    assert.equal(getActiveReviewCount(), 0);

    await runWithActiveReview(job(), async () => {
      noteActiveCheckoutDir(root);
      noteActiveChildSpawn(process.pid); // self — readable on Linux/mac via /proc or skipped
      assert.equal(getActiveReviewCount(), 1);
      const snap = sampleActiveReviews({ maxConcurrent: 4 });
      assert.equal(snap.host.worker.activeReviews, 1);
      assert.equal(snap.host.worker.maxConcurrentReviews, 4);
      assert.equal(snap.reviews.length, 1);
      const row = snap.reviews[0]!;
      assert.equal(row.owner, 'acme');
      assert.equal(row.repo, 'api');
      assert.equal(row.pr, 42);
      assert.equal(row.kind, 'review');
      assert.ok(row.checkoutDiskBytes >= 2048);
      assert.ok(row.elapsedMs >= 0);
      assert.ok(row.estimatedNodeRssShareBytes > 0);
      assert.ok(snap.host.memory.totalBytes > 0);
      assert.ok(snap.host.disk.totalBytes >= 0);
    });

    assert.equal(getActiveReviewCount(), 0);
    assert.equal(sampleActiveReviews().reviews.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('concurrent reviews appear as separate client rows', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const first = runWithActiveReview(job({ pr: 1, tenantId: 't1' }), async () => {
    await gate;
    return 'done-1';
  });
  const second = runWithActiveReview(job({ pr: 2, tenantId: 't2' }), async () => {
    // Both entries must be registered before we sample.
    await new Promise((r) => setTimeout(r, 5));
    const prs = sampleActiveReviews()
      .reviews.map((r) => r.pr)
      .sort((x, y) => x - y);
    release();
    return prs;
  });

  const [, prs] = await Promise.all([first, second]);
  assert.deepEqual(prs, [1, 2]);
});

test('PR cancellation aborts only the matching active review and is idempotent', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const signals = new Map<number, AbortSignal>();
  let bothReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    bothReady = resolve;
  });

  const run = (pr: number) =>
    runWithActiveReview(job({ pr }), async () => {
      const signal = activeReviewSignal();
      assert.ok(signal);
      signals.set(pr, signal);
      if (signals.size === 2) bothReady();
      await gate;
    });

  const first = run(11);
  const second = run(12);
  await ready;

  assert.equal(
    cancelActiveReviewsForPr({ installationId: 1, owner: 'ACME', repo: 'API', pr: 11 }),
    1,
  );
  assert.equal(signals.get(11)?.aborted, true);
  assert.equal(signals.get(12)?.aborted, false);
  assert.equal(
    cancelActiveReviewsForPr({ installationId: 1, owner: 'acme', repo: 'api', pr: 11 }),
    0,
    'duplicate close delivery must not count or throw',
  );

  release();
  await Promise.all([first, second]);
});

test('worker shutdown cancellation aborts every active review', async () => {
  const signals: AbortSignal[] = [];
  let bothReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    bothReady = resolve;
  });
  const run = (pr: number) =>
    runWithActiveReview(job({ pr }), async () => {
      const signal = activeReviewSignal();
      assert.ok(signal);
      signals.push(signal);
      if (signals.length === 2) bothReady();
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
    });

  const first = run(21);
  const second = run(22);
  await ready;
  assert.equal(cancelAllActiveReviews(), 2);
  await Promise.all([first, second]);
  assert.ok(signals.every((signal) => signal.aborted));
  assert.equal(cancelAllActiveReviews(), 0);
});
