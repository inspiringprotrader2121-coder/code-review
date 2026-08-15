import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_REVIEW_CONFIG } from '@orvex-review/rules';
import { AdmissionService } from './admission-service.js';
import { FindingPipeline } from './finding-pipeline.js';
import { PublicationInProgressError, PublicationService } from './publication-service.js';
import {
  describeRequiredCoverageDegradation,
  shouldRequeueIncompleteCoverage,
  ReviewExecutor,
} from './review-executor.js';
import { createReviewUsageAccounting } from './review-usage-accounting.js';
import { orchestrateVerification } from './verification-orchestrator.js';
import { DEFAULT_USAGE_COST_POLICY } from '../../review/usage-accounting.js';
import { processReviewJob } from '../../pipeline.js';

const finding = {
  file: 'src/example.ts',
  line: 99,
  severity: 'P2' as const,
  category: 'correctness',
  message:
    'When the changed branch receives an empty token, it throws before returning an error response.',
  confidence: 0.9,
  ruleId: 'test-rule',
};

test('finding computation is independent from GitHub publication', () => {
  const result = new FindingPipeline().prepare({
    files: [{ filename: 'src/example.ts', patch: '@@ -1 +1 @@\n-old\n+new' }],
    reviewConfig: DEFAULT_REVIEW_CONFIG,
    priorFindings: [],
    verifiedFixed: [],
    toPost: [finding],
    reviewOnly: [],
    newlyFixed: [],
    stillOpen: [],
    maxInlinePerPr: 25,
  });

  assert.equal(result.toPost[0]?.line, 1, 'a finding is anchored before publication');
  assert.equal(result.stats.newCount, 1);
  assert.equal(result.inline.length, 1);
});

test('review execution accepts an injected computation without provider or GitHub access', async () => {
  let invoked = 0;
  const executor = new ReviewExecutor(async () => {
    invoked += 1;
    return { findingCount: 2, newCount: 2, fixedCount: 0 };
  });

  const result = await executor.execute({} as never);
  assert.equal(invoked, 1);
  assert.equal(result.findingCount, 2);
  assert.deepEqual(
    await executor.mapConcurrent([1, 2, 3], 2, async (value) => value * 2),
    [2, 4, 6],
  );
});

test('missing required coverage is publishable only with an explicit incomplete disclosure', () => {
  const degradation = describeRequiredCoverageDegradation(
    ['required:general:0:chunk:1/1', 'required:deep-dive:1:chunk:1/1'],
    [
      {
        requiredCoverageKey: 'required:general:0:chunk:1/1',
        label: 'pass 1/4 (general)',
        ok: true,
      },
      {
        requiredCoverageKey: 'required:deep-dive:1:chunk:1/1',
        label: 'pass 2/4 (deep-dive)',
        ok: false,
        transient: true,
      },
    ],
    1,
  );

  assert.deepEqual(degradation, {
    missingCoverageKeys: ['required:deep-dive:1:chunk:1/1'],
    skippedLenses: ['pass 2/4 (deep-dive)'],
    transient: true,
    admissionBlocked: false,
    reason:
      'review incomplete: 1/2 required review coverage unit(s) did not complete because a provider timed out or was temporarily unavailable',
  });
});

test('admission saturation is disclosed as admissionBlocked so the executor can requeue', () => {
  const degradation = describeRequiredCoverageDegradation(
    ['required:general:0:chunk:1/1', 'required:deep-dive:1:chunk:1/1'],
    [
      {
        requiredCoverageKey: 'required:general:0:chunk:1/1',
        label: 'pass 1/4 (general)',
        ok: true,
      },
      {
        requiredCoverageKey: 'required:deep-dive:1:chunk:1/1',
        label: 'pass 2/4 (deep-dive)',
        ok: false,
        transient: true,
        admissionBlocked: true,
      },
    ],
    1,
  );
  assert.equal(degradation?.admissionBlocked, true);
  assert.match(degradation?.reason ?? '', /admission was saturated/);
  assert.equal(shouldRequeueIncompleteCoverage(degradation), true);
});

test('a missing MiniMax, Flash, or Luna pass requeues instead of publishing without that model', () => {
  const minimax = describeRequiredCoverageDegradation(
    ['required:general:0:chunk:1/1', 'required:perf:2:chunk:1/1'],
    [
      { requiredCoverageKey: 'required:general:0:chunk:1/1', ok: true },
      {
        requiredCoverageKey: 'required:perf:2:chunk:1/1',
        label: 'pass 3/4 (perf) [minimax-m3]',
        ok: false,
        transient: true,
      },
    ],
    1,
  );
  assert.equal(shouldRequeueIncompleteCoverage(minimax), true);

  const flash = describeRequiredCoverageDegradation(
    ['required:general:0:chunk:1/1', 'required:deep-dive:1:chunk:1/1'],
    [
      { requiredCoverageKey: 'required:general:0:chunk:1/1', ok: true },
      {
        requiredCoverageKey: 'required:deep-dive:1:chunk:1/1',
        ok: false,
        transient: true,
        admissionBlocked: true,
      },
    ],
    1,
  );
  assert.equal(shouldRequeueIncompleteCoverage(flash), true);

  const parseFailure = describeRequiredCoverageDegradation(
    ['required:general:0:chunk:1/1'],
    [{ requiredCoverageKey: 'required:general:0:chunk:1/1', ok: false, transient: false }],
    1,
  );
  assert.equal(shouldRequeueIncompleteCoverage(parseFailure), false);
});

test('a successful unsharded agentic lens satisfies its fallback coverage key', () => {
  const degradation = describeRequiredCoverageDegradation(
    ['lens:0', 'required:deep-dive:1:chunk:1/1'],
    [
      {
        modelPassIndex: 0,
        label: 'pass 1/4 (general) [gpt-5.6-luna]',
        ok: true,
      },
      {
        modelPassIndex: 1,
        requiredCoverageKey: 'required:deep-dive:1:chunk:1/1',
        label: 'pass 2/4 (deep-dive) [deepseek-v4-flash] chunk 1/1',
        ok: true,
      },
    ],
    1,
  );

  assert.equal(degradation, null);
});

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
    {
      tenantId: 'tenant-1',
      installationId: 1,
      owner: 'acme',
      repo: 'api',
      pr: 9,
      headSha: 'abc',
      action: 'opened',
    } as never,
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

test('admission can reject an unavailable provider before review computation', async () => {
  const recorded: unknown[] = [];
  const admission = new AdmissionService({
    providerIssue: () => 'provider unavailable',
    accountLimitReason: () => null,
    prepaidOverageDebitCents: () => 0,
    postLimitNudge: async () => assert.fail('provider rejection is not a quota nudge'),
    postFailureNotice: async () =>
      assert.fail('existing notice suppresses a duplicate GitHub write'),
    postCooldownNotice: async () => assert.fail('automatic reviews do not use cooldown notices'),
  });
  const result = await admission.admit(
    {
      tenantId: 'tenant-1',
      installationId: 1,
      owner: 'acme',
      repo: 'api',
      pr: 4,
      headSha: 'abc',
      action: 'opened',
    } as never,
    {
      store: {
        getTenantPlan: () => 'review',
        recordReviewRun: (run: unknown) => recorded.push(run),
        countRecentSkippedRuns: () => 2,
      },
    } as never,
  );

  assert.equal(result.kind, 'skipped');
  assert.equal(result.result.skipReason, 'provider_not_configured');
  assert.equal(recorded.length, 1);
});

test('publication coalesces duplicate writes for the same artifact key', async () => {
  const publication = new PublicationService();
  let writes = 0;
  const first = publication.publish('installation:1/pr:4/sha:abc', async () => {
    writes += 1;
    return { reviewId: 42 };
  });
  const second = publication.publish('installation:1/pr:4/sha:abc', async () => {
    writes += 1;
    return { reviewId: 99 };
  });

  assert.deepEqual(await first, { reviewId: 42 });
  assert.deepEqual(await second, { reviewId: 42 });
  assert.equal(writes, 1);
});

test('review publication refuses local-only coalescing without durable claims', async () => {
  await assert.rejects(
    new PublicationService().publishReview({ runId: 'run-1' } as never),
    /durable publication requires a review run and repository/,
  );
});

test('durable publication claims prevent cross-service duplicate GitHub writes and retain the first result', async () => {
  const claims = new Map<
    string,
    { state: 'publishing' | 'published'; token: string; resultJson: string | null }
  >();
  let nextToken = 0;
  const repository = {
    claimReviewPublication(scope: { tenantId: string; runId: string; artifactKey: string }) {
      const key = `${scope.tenantId}:${scope.runId}:${scope.artifactKey}`;
      const existing = claims.get(key);
      if (existing?.state === 'published')
        return { status: 'published' as const, resultJson: existing.resultJson };
      if (existing) return { status: 'in_progress' as const };
      const token = `token-${++nextToken}`;
      claims.set(key, { state: 'publishing', token, resultJson: null });
      return { status: 'claimed' as const, claimToken: token };
    },
    completeReviewPublication(input: {
      tenantId: string;
      runId: string;
      artifactKey: string;
      claimToken: string;
      resultJson: string | null;
    }) {
      const key = `${input.tenantId}:${input.runId}:${input.artifactKey}`;
      const claim = claims.get(key);
      if (!claim || claim.state !== 'publishing' || claim.token !== input.claimToken) return false;
      claim.state = 'published';
      claim.resultJson = input.resultJson;
      return true;
    },
    releaseReviewPublication(input: {
      tenantId: string;
      runId: string;
      artifactKey: string;
      claimToken: string;
    }) {
      const key = `${input.tenantId}:${input.runId}:${input.artifactKey}`;
      const claim = claims.get(key);
      if (!claim || claim.state !== 'publishing' || claim.token !== input.claimToken) return false;
      claims.delete(key);
      return true;
    },
  };
  const first = new PublicationService(repository);
  const second = new PublicationService(repository);
  const scope = { tenantId: 'tenant-1', runId: 'run-1' };
  let writes = 0;
  const firstWrite = first.publishArtifact(scope, 'review:abc', async () => {
    writes += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { reviewId: 42 };
  });
  await assert.rejects(
    second.publishArtifact(scope, 'review:abc', async () => ({ reviewId: 99 })),
    PublicationInProgressError,
  );
  assert.deepEqual(await firstWrite, { reviewId: 42 });
  assert.deepEqual(
    await second.publishArtifact(scope, 'review:abc', async () => ({ reviewId: 99 })),
    { reviewId: 42 },
  );
  assert.equal(writes, 1);
});

test('durable publication claims release a known failed write for a retry', async () => {
  let claimed = false;
  const repository = {
    claimReviewPublication: () => {
      if (claimed) return { status: 'in_progress' as const };
      claimed = true;
      return { status: 'claimed' as const, claimToken: 'token' };
    },
    completeReviewPublication: () => true,
    releaseReviewPublication: () => {
      claimed = false;
      return true;
    },
  };
  const publication = new PublicationService(repository);
  const scope = { tenantId: 'tenant-1', runId: 'run-1' };
  await assert.rejects(
    publication.publishArtifact(scope, 'check:abc', async () => {
      throw new Error('network failed');
    }),
    /network failed/,
  );
  assert.equal(await publication.publishArtifact(scope, 'check:abc', async () => 7), 7);
});

test('fixed-finding replies use tenant and run scoped durable publication claims', async () => {
  const records = new Map<
    string,
    { state: 'publishing' | 'published'; token: string; resultJson: string | null }
  >();
  const repository = {
    claimReviewPublication(scope: { tenantId: string; runId: string; artifactKey: string }) {
      const key = `${scope.tenantId}:${scope.runId}:${scope.artifactKey}`;
      const existing = records.get(key);
      if (existing?.state === 'published')
        return { status: 'published' as const, resultJson: existing.resultJson };
      if (existing) return { status: 'in_progress' as const };
      records.set(key, { state: 'publishing', token: 'reply-token', resultJson: null });
      return { status: 'claimed' as const, claimToken: 'reply-token' };
    },
    completeReviewPublication(input: {
      tenantId: string;
      runId: string;
      artifactKey: string;
      claimToken: string;
      resultJson: string | null;
    }) {
      const key = `${input.tenantId}:${input.runId}:${input.artifactKey}`;
      const record = records.get(key);
      if (!record || record.token !== input.claimToken) return false;
      record.state = 'published';
      record.resultJson = input.resultJson;
      return true;
    },
    releaseReviewPublication: () => false,
  };
  let replies = 0;
  const octokit = {
    rest: {
      pulls: {
        createReplyForReviewComment: async () => {
          replies += 1;
          return { data: {} };
        },
      },
    },
  } as never;
  const input = {
    scope: { tenantId: 'tenant-1', runId: 'run-1' },
    octokit,
    owner: 'acme',
    repo: 'api',
    number: 4,
    effectiveSha: 'abc123',
    fixed: [{ githubCommentId: 77, fingerprint: 'fp-1' }],
  } as never;
  await new PublicationService(repository).publishFixedReplies(input);
  await new PublicationService(repository).publishFixedReplies(input);
  assert.equal(replies, 1);
  assert.equal([...records.keys()][0]?.includes('tenant-1:run-1:fixed-reply:'), true);
});

test('processReviewJob coordinates injected services without GitHub or providers', async () => {
  const calls: string[] = [];
  const job = {
    tenantId: 'tenant-1',
    installationId: 1,
    owner: 'acme',
    repo: 'api',
    pr: 4,
    headSha: 'abc',
    action: 'opened',
  } as never;
  const config = {} as never;
  const admitted = {
    job,
    config,
    runId: 'run-1',
    startedAt: 10,
    plan: { overageCentsPerReview: null },
  } as never;
  const prepared = { job, config, runId: 'run-1' } as never;
  const result = await processReviewJob(job, config, {
    admission: {
      admit: async () => {
        calls.push('admit');
        return { kind: 'admitted', review: admitted };
      },
    },
    preparation: {
      prepare: async () => {
        calls.push('prepare');
        return prepared;
      },
    },
    executor: {
      execute: async () => {
        calls.push('execute');
        return { findingCount: 1, newCount: 1, fixedCount: 0 };
      },
    },
    finalization: {
      complete: async (_review, value) => {
        calls.push('complete');
        return value;
      },
      fail: async (_review, error) => {
        throw error;
      },
    },
  });
  assert.deepEqual(calls, ['admit', 'prepare', 'execute', 'complete']);
  assert.equal(result.findingCount, 1);
});

test('processReviewJob finalizes an admitted review when preparation fails', async () => {
  const job = {
    tenantId: 'tenant-1',
    installationId: 1,
    owner: 'acme',
    repo: 'api',
    pr: 4,
    headSha: 'abc',
    action: 'opened',
  } as never;
  const config = {} as never;
  const admitted = {
    job,
    config,
    runId: 'run-1',
    startedAt: 10,
    plan: { overageCentsPerReview: null },
  } as never;
  const preparationError = new Error('GitHub diff unavailable');
  let failedReview: unknown;

  await assert.rejects(
    processReviewJob(job, config, {
      admission: { admit: async () => ({ kind: 'admitted', review: admitted }) },
      preparation: { prepare: async () => Promise.reject(preparationError) },
      executor: { execute: async () => assert.fail('execution must not start') },
      finalization: {
        complete: async () => assert.fail('completion must not start'),
        fail: async (review, error) => {
          failedReview = review;
          throw error;
        },
      },
    }),
    preparationError,
  );

  assert.equal(failedReview, admitted);
});

test('usage accounting records provider lifecycle through its narrow store port', () => {
  const usage: unknown[] = [];
  const attempts: unknown[] = [];
  const accounting = createReviewUsageAccounting({
    runId: 'run-1',
    tenantId: 'tenant-1',
    policy: DEFAULT_USAGE_COST_POLICY,
    store: {
      recordReviewRunUsage: (event) => {
        usage.push(event);
        return event;
      },
      startReviewRunAttempt: (event) => {
        attempts.push(event);
        return true;
      },
      completeReviewRunAttempt: (event) => {
        attempts.push(event);
        return true;
      },
    },
    onOwnershipLoss: () => assert.fail('the fake store retains ownership'),
  });
  const target = {
    model: 'model',
    apiKey: 'test',
    transport: 'responses',
    admissionBucket: 'test',
    thinking: false,
  } as const;
  accounting.onAttemptFor(
    'standard',
    'discovery',
  )({
    phase: 'started',
    attemptId: 'attempt-1',
    provider: 'test',
    model: 'model',
    transport: 'responses',
    retryIndex: 0,
    keyIndex: 0,
    startedAt: '2026-01-01T00:00:00.000Z',
  });
  accounting.onUsageFor(
    'standard',
    target,
    'discovery',
  )({
    inputTokens: 3,
    cachedInputTokens: 0,
    outputTokens: 5,
  });
  accounting.onAttemptFor(
    'standard',
    'discovery',
  )({
    phase: 'finished',
    attemptId: 'attempt-1',
    outcome: 'succeeded',
    durationMs: 2,
    completedAt: '2026-01-01T00:00:00.002Z',
  });
  accounting.onAttemptFor(
    'standard',
    'discovery',
  )({
    phase: 'started',
    attemptId: 'attempt-2',
    parentAttemptId: 'attempt-1',
    role: 'continuation',
    provider: 'test',
    model: 'model',
    transport: 'chat',
    retryIndex: 1,
    keyIndex: 0,
    startedAt: '2026-01-01T00:00:00.003Z',
  });
  assert.equal(attempts.length, 3);
  assert.equal(usage.length, 1);
  assert.equal((attempts[2] as { role?: string }).role, 'continuation');
  assert.deepEqual(accounting.usage.openai, {
    in: 3,
    cachedIn: 0,
    out: 5,
    costUsd: 0.0000066,
  });
});

test('verification does not call a provider when the feature is disabled', async () => {
  const result = await orchestrateVerification({
    candidates: [],
    toPost: [],
    reviewOnly: [],
    files: [],
    enabled: false,
    deepVerify: false,
    target: {
      model: 'model',
      apiKey: 'test',
      transport: 'responses',
      admissionBucket: 'test',
      thinking: false,
    },
    tier: 'standard',
    signal: new AbortController().signal,
    providers: {} as never,
    findings: {} as never,
    onUsage: () => {},
    onAttempt: () => {},
  });
  assert.deepEqual(result, { toPost: [], reviewOnly: [], incomplete: false });
});
