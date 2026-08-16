import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdmissionService } from './admission-service.js';

const job = {
  tenantId: 'tenant-1',
  installationId: 1,
  owner: 'acme',
  repo: 'api',
  pr: 9,
  headSha: 'abc',
  action: 'opened' as const,
};

test('admission defers tenant concurrency instead of skipping the review', async () => {
  let nudged = 0;
  const admission = new AdmissionService({
    providerIssue: () => null,
    accountLimitReason: () => 'concurrency_limited',
    prepaidOverageDebitCents: () => 0,
    postLimitNudge: async () => {
      nudged += 1;
    },
    postFailureNotice: async () => assert.fail('concurrency deferral is not a failure notice'),
    postCooldownNotice: async () => assert.fail('concurrency deferral is not a cooldown notice'),
  });
  const result = await admission.admit(
    job as never,
    {
      store: {
        getTenantPlan: () => 'enterprise',
        tryReserveReviewRun: (
          _input: unknown,
          limitReason: () => string | null,
        ): { ok: false; reason: string } => ({
          ok: false,
          reason: limitReason() ?? 'concurrency_limited',
        }),
      },
    } as never,
  );

  assert.equal(result.kind, 'deferred');
  if (result.kind === 'deferred') assert.equal(result.reason, 'concurrency_limited');
  assert.equal(nudged, 0);
});

test('admission defers hourly rate limits instead of skipping the review', async () => {
  const admission = new AdmissionService({
    providerIssue: () => null,
    accountLimitReason: () => 'rate_limited',
    prepaidOverageDebitCents: () => 0,
    postLimitNudge: async () => assert.fail('hourly deferral is not a quota nudge'),
    postFailureNotice: async () => assert.fail('hourly deferral is not a failure notice'),
    postCooldownNotice: async () => assert.fail('hourly deferral is not a cooldown notice'),
  });
  const result = await admission.admit(
    job as never,
    {
      store: {
        getTenantPlan: () => 'enterprise',
        tryReserveReviewRun: (
          _input: unknown,
          limitReason: () => string | null,
        ): { ok: false; reason: string } => ({
          ok: false,
          reason: limitReason() ?? 'rate_limited',
        }),
      },
    } as never,
  );

  assert.equal(result.kind, 'deferred');
  if (result.kind === 'deferred') assert.equal(result.reason, 'rate_limited');
});
