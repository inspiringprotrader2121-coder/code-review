import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  ResolveReviewPublicationInput,
  ReviewPublicationOperatorRepository,
} from '@orvex-review/store';
import { PublicationOperatorService } from './publication-operator-service.js';

function fakeRepository(resolve = true): {
  repository: ReviewPublicationOperatorRepository;
  resolutions: ResolveReviewPublicationInput[];
} {
  const resolutions: ResolveReviewPublicationInput[] = [];
  return {
    resolutions,
    repository: {
      listAbandonedReviewPublications: () => [],
      listReviewPublicationResolutions: () => [],
      resolveAbandonedReviewPublication: (input) => {
        resolutions.push(input);
        return resolve;
      },
    },
  };
}

test('operator retry only clears an abandoned claim through the repository and records server-owned audit context', () => {
  const { repository, resolutions } = fakeRepository();
  const service = new PublicationOperatorService(repository, () =>
    Date.parse('2026-08-09T12:30:00.000Z'),
  );
  const result = service.resolve(
    {
      tenantId: 'tenant-1',
      runId: 'run-1',
      artifactKey: 'fixed-reply:acme/api:72@abc',
      action: 'retry',
      reason: 'GitHub confirms no reply exists',
      resultProvided: false,
    },
    'admin-secret',
  );

  assert.deepEqual(result, { kind: 'resolved', action: 'retry' });
  assert.equal(resolutions.length, 1);
  assert.equal(resolutions[0]?.actor, 'admin-secret');
  assert.equal(resolutions[0]?.abandonedBefore, '2026-08-09T12:15:00.000Z');
  assert.equal(resolutions[0]?.resultJson, undefined);
});

test('mark-published validates and canonicalizes the GitHub result before resolving', () => {
  const { repository, resolutions } = fakeRepository();
  const service = new PublicationOperatorService(repository);
  const common = {
    tenantId: 'tenant-1',
    runId: 'run-1',
    artifactKey: 'review:abc',
    action: 'mark-published',
    reason: 'Verified the review on GitHub',
  };
  assert.equal(service.resolve({ ...common, resultProvided: false }, 'operator').kind, 'invalid');
  assert.equal(
    service.resolve(
      {
        ...common,
        resultProvided: true,
        result: { reviewId: 42, reviewUrl: 'http://github.com/acme/api/review/42', commentIds: [] },
      },
      'operator',
    ).kind,
    'invalid',
  );

  const result = service.resolve(
    {
      ...common,
      resultProvided: true,
      result: {
        reviewId: 42,
        reviewUrl: 'https://github.com/acme/api/pull/7#pullrequestreview-42',
        commentIds: [{ path: 'src/index.ts', line: 4, id: 91 }],
        ignoredField: 'not persisted',
      },
    },
    'operator',
  );
  assert.deepEqual(result, { kind: 'resolved', action: 'mark_published' });
  assert.deepEqual(JSON.parse(resolutions[0]?.resultJson ?? 'null'), {
    reviewId: 42,
    reviewUrl: 'https://github.com/acme/api/pull/7#pullrequestreview-42',
    commentIds: [{ path: 'src/index.ts', line: 4, id: 91 }],
  });
});

test('operator resolution reports a conflict when the claim is active or already resolved', () => {
  const { repository } = fakeRepository(false);
  const service = new PublicationOperatorService(repository);
  assert.deepEqual(
    service.resolve(
      {
        tenantId: 'tenant-1',
        runId: 'run-1',
        artifactKey: 'check:abc',
        action: 'retry',
        reason: 'Confirmed no check exists',
        resultProvided: false,
      },
      'operator',
    ),
    { kind: 'conflict' },
  );
});
