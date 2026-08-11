import assert from 'node:assert/strict';
import { test } from 'node:test';
import { publishCheckRun } from './check-run.js';
import type { ArtifactPublisher, PublicationInput } from './contracts.js';

test('a completed verifier with an inconclusive Critical/High finding has an accurate neutral check', async () => {
  let request: Record<string, unknown> | undefined;
  const publisher: ArtifactPublisher = {
    publishArtifact: async (_scope, _key, write) => write(),
  };
  const input = {
    config: { enableCheckRuns: true },
    findings: { stats: { newCount: 6, fixedCount: 0, openCount: 6 } },
    merged: { reviewOnly: [] },
    skippedLenses: [],
    verificationIncomplete: true,
    verificationInconclusiveCount: 1,
    policy: { failCheckOnP1: false },
    octokit: {
      rest: {
        checks: {
          create: async (value: Record<string, unknown>) => {
            request = value;
            return { data: { id: 1 } };
          },
        },
      },
    },
    ref: { owner: 'acme', repo: 'api', number: 4 },
    effectiveSha: 'abc123',
  } as unknown as PublicationInput;

  await publishCheckRun(publisher, input, { tenantId: 'tenant-1', runId: 'run-1' }, []);

  assert.equal(request?.conclusion, 'neutral');
  assert.equal(request?.output?.title, 'Orvex Review (inconclusive finding)');
  assert.match(
    String(request?.output?.summary),
    /1 Critical\/High finding remains visible for manual review/,
  );
  assert.doesNotMatch(String(request?.output?.summary), /did not complete/);
});
