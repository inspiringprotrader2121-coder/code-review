import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryProviderAdmission, type ProviderAdmission } from './provider-admission.js';
import { MemoryReviewQueue } from './memory.js';
import { jobIdempotencyKey, prKey, type ReviewJobPayload } from './types.js';

function job(index: number): ReviewJobPayload {
  return {
    installationId: 17,
    tenantId: 'stress-tenant',
    owner: 'orvex',
    repo: 'queue-stress',
    pr: index,
    headSha: `sha-${index}`,
    action: 'opened',
    enqueuedAt: new Date(Date.UTC(2026, 7, 9, 12, 0, index)).toISOString(),
  };
}

test('eight workers drain hundreds of jobs once with a shared provider cap and no silent drops', async () => {
  const admission = new MemoryProviderAdmission({ retryDelayMs: 1 });
  const queue = new MemoryReviewQueue({ providerAdmission: admission });
  const jobs = Array.from({ length: 400 }, (_, index) => job(index + 1));
  const accepted = await Promise.all(jobs.map((payload) => queue.enqueue(payload)));
  assert.equal(accepted.filter((result) => result.accepted).length, jobs.length);

  let active = 0;
  let peak = 0;
  const completed = new Set<string>();
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      for (;;) {
        const claimed = await queue.dequeue();
        if (!claimed) return;
        assert.equal(await queue.markRunning(claimed), true);
        const token = await admission.acquireProviderLease('deepseek', 3);
        active += 1;
        peak = Math.max(peak, active);
        try {
          await new Promise((resolve) => setTimeout(resolve, 1));
          const id = jobIdempotencyKey(claimed);
          assert.equal(completed.has(id), false, `duplicate completion: ${id}`);
          completed.add(id);
          assert.equal(await queue.markCompleted(claimed), true);
          await queue.releaseLockAndDrain(prKey(claimed));
        } finally {
          active -= 1;
          await admission.releaseProviderLease('deepseek', token);
        }
      }
    }),
  );

  assert.equal(peak, 3, 'provider admission stayed capped across all eight workers');
  assert.equal(active, 0);
  assert.equal(completed.size, jobs.length, 'every accepted job reached exactly one completion');
  assert.deepEqual(await queue.depth(), {
    queued: 0,
    waitingOnPr: 0,
    inFlight: 0,
    oldestQueuedAt: null,
  });
});

test('provider admission can be injected independently from queue ownership', async () => {
  const queue = new MemoryReviewQueue({ providerAdmission: new RejectingAdmission() });
  const payload = job(999);
  await queue.enqueue(payload);
  const claimed = await queue.dequeue();
  assert.ok(claimed);
  await assert.rejects(
    queue.providerAdmission.acquireProviderLease('luna', 1),
    /admission unavailable/,
  );
  assert.equal(
    await queue.markCompleted(claimed),
    true,
    'admission failure cannot corrupt queue ownership',
  );
});

class RejectingAdmission implements ProviderAdmission {
  async acquireProviderLease(): Promise<string> {
    throw new Error('admission unavailable');
  }
  async releaseProviderLease(): Promise<void> {}
  async getProviderCooldownMs(): Promise<number> {
    return 0;
  }
  async setProviderCooldown(): Promise<void> {}
}
