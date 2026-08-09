import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fingerprintFinding } from '@orvex-review/review';
import { serializeReviewState } from './review-state.js';

const finding = {
  file: 'src/handler.ts',
  line: 18,
  severity: 'P2' as const,
  category: 'correctness',
  message: 'The retry path can publish the same comment twice.',
  confidence: 0.95,
  ruleId: 'duplicate-publication',
};

function input(overrides: Record<string, unknown> = {}) {
  return {
    installationId: 3,
    tenantId: 'tenant-a',
    owner: 'acme',
    repo: 'api',
    number: 17,
    effectiveSha: 'head-sha',
    codexThreadId: 'thread-1',
    findings: {
      allFixed: [],
      inline: [finding],
      summaryOnly: [],
      nitpicks: [],
      stats: { newCount: 1, fixedCount: 0, openCount: 1 },
    },
    merged: { toPost: [finding], reviewOnly: [], stillOpen: [] },
    priorState: null,
    ...overrides,
  } as never;
}

test('review state serialization records inline comment ids and manual review candidates', () => {
  const result = serializeReviewState(
    input({
      merged: {
        toPost: [finding],
        reviewOnly: [{ finding, reason: 'insufficient evidence' }],
        stillOpen: [],
      },
    }),
    new Map([['src/handler.ts:18', 91]]),
  );

  assert.equal(result.state.findings[0]?.githubCommentId, 91);
  assert.equal(result.state.manualReview[0]?.fingerprint, result.state.findings[0]?.fingerprint);
  assert.equal(result.state.codexThreadId, 'thread-1');
});

test('review state serialization reopens a previously fixed finding without losing its first-seen SHA', () => {
  const priorFinding = {
    fingerprint: fingerprintFinding(finding),
    severity: 'P2' as const,
    file: 'src/handler.ts',
    line: 18,
    message: finding.message,
    status: 'fixed' as const,
    firstSeenSha: 'original-sha',
    fixedAtSha: 'old-head',
  };
  const result = serializeReviewState(
    input({
      priorState: { findings: [priorFinding] },
    }),
    new Map(),
  );

  assert.equal(result.finalFindings.length, 1);
  assert.equal(result.finalFindings[0]?.status, 'open');
  assert.equal(result.finalFindings[0]?.firstSeenSha, 'original-sha');
});
