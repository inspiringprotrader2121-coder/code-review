import assert from 'node:assert/strict';
import { test } from 'node:test';
import { publishReview } from './review-publication.js';

function publicationInput(overrides: Record<string, unknown> = {}) {
  return {
    job: { deep: false },
    config: {
      store: {
        heartbeatReviewRun: () => true,
        saveState: () => undefined,
        markReviewedNow: () => undefined,
      },
      enableCheckRuns: false,
    },
    runId: 'run-1',
    octokit: {
      rest: {
        pulls: {
          get: async () => ({ data: { state: 'open' } }),
          createReview: async () => ({
            data: { id: 17, html_url: 'https://example.test/review/17' },
          }),
        },
      },
    },
    ref: { owner: 'acme', repo: 'api', number: 4 },
    owner: 'acme',
    repo: 'api',
    number: 4,
    installationId: 1,
    tenantId: 'tenant-1',
    effectiveSha: 'abc123',
    plan: { id: 'verify', autofix: false, codeExecution: false, modelTier: 'hybrid' },
    pr: {},
    coverage: {
      complete: true,
      reviewed: 1,
      candidates: 1,
      skippedByCap: 0,
      truncatedFiles: 0,
      omittedPatch: 0,
    },
    filesForLlm: [],
    reviewContextFiles: [],
    merged: { toPost: [], reviewOnly: [], stillOpen: [] },
    findings: {
      inline: [],
      summaryOnly: [],
      nitpicks: [],
      allFixed: [],
      stats: { newCount: 0, fixedCount: 0, openCount: 0 },
    },
    skippedLenses: [],
    verificationIncomplete: false,
    usage: {},
    usagePolicy: {},
    deepLensesRan: false,
    policy: { requestChangesOnP1: false, maxUnanchoredComments: 3, failCheckOnP1: false },
    signal: new AbortController().signal,
    ownershipLost: () => false,
    cancelForOwnershipLoss: () => undefined,
    ...overrides,
  } as never;
}

const directPublisher = {
  publishArtifact: async <T>(
    _scope: { tenantId: string; runId: string } | undefined,
    _artifactKey: string,
    write: () => Promise<T>,
  ) => write(),
};

test('a check-run failure cannot turn an accepted review into a failed result', async () => {
  let reviews = 0;
  let checks = 0;
  const input = publicationInput({
    config: {
      ...publicationInput().config,
      enableCheckRuns: true,
    },
    octokit: {
      rest: {
        pulls: {
          get: async () => ({ data: { state: 'open' } }),
          createReview: async () => {
            reviews += 1;
            return { data: { id: 17, html_url: 'https://example.test/review/17' } };
          },
        },
        checks: {
          create: async () => {
            checks += 1;
            throw new Error('check API unavailable');
          },
        },
      },
    },
  });

  const result = await publishReview(directPublisher, input);

  assert.equal(result.published, true);
  assert.equal(result.reviewId, 17);
  assert.equal(reviews, 1);
  assert.equal(checks, 1);
});

test('runtime-evidence failure cannot turn an accepted review into a failed result', async () => {
  const input = publicationInput({
    config: {
      ...publicationInput().config,
      sandboxRuntime: { codeExecutionEnabled: true },
    },
    plan: { id: 'enterprise', autofix: false, codeExecution: true, modelTier: 'hybrid' },
  });

  const result = await publishReview(directPublisher, input);

  assert.equal(result.published, true);
  assert.equal(result.reviewId, 17);
});

test('verification-incomplete publication records the limitation in the durable run result', async () => {
  const input = publicationInput({
    verificationIncomplete: true,
    verificationUnavailableReason: 'verifier response contained no parseable JSON',
  });

  const result = await publishReview(directPublisher, input);

  assert.equal(result.published, true);
  assert.match(result.incompleteReason ?? '', /^review incomplete: verification did not complete/);
  assert.match(result.incompleteReason ?? '', /no parseable JSON/);
});

test('summary-table findings are not posted as detached issue comments', async () => {
  let issueComments = 0;
  const input = publicationInput({
    plan: { id: 'enterprise', autofix: true, codeExecution: true, modelTier: 'multi-model' },
    findings: {
      inline: [],
      summaryOnly: [
        {
          file: 'backend/src/lib/redis-lock.js',
          line: 168,
          severity: 'P3',
          category: 'correctness',
          message: 'fence resets to zero for every acquisition',
          confidence: 0.8,
          ruleId: 'llm.general',
        },
      ],
      nitpicks: [],
      allFixed: [],
      stats: { newCount: 1, fixedCount: 0, openCount: 1 },
    },
    octokit: {
      rest: {
        pulls: {
          get: async () => ({ data: { state: 'open' } }),
          createReview: async () => ({
            data: { id: 17, html_url: 'https://example.test/review/17' },
          }),
        },
        issues: {
          createComment: async () => {
            issueComments += 1;
            return { data: { id: 99 } };
          },
        },
      },
    },
  });

  const result = await publishReview(directPublisher, input);

  assert.equal(result.published, true);
  assert.equal(issueComments, 0);
});
