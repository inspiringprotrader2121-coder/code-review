import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StoredFinding } from '@orvex-review/store';
import { commandPrecheck, completeCommandRun, reserveCommandRun } from './command-admission.js';
import type { AutofixDependencies, AutofixRuntime } from './contracts.js';
import { selectTargets } from './target-selection.js';

const runtime: AutofixRuntime = {
  autofix: {
    commandsPerHour: 3,
    maxFixRunsPerDay: 30,
    maxFixTargets: 25,
    deepContext: false,
    context: { maxSourceFiles: 1, maxRelated: 1, maxDependents: 1, maxFileBytes: 1, maxOthers: 1 },
  },
  verificationEnabled: true,
} as never;

const finding = (overrides: Partial<StoredFinding>): StoredFinding => ({
  id: 'finding-1',
  fingerprint: 'one',
  file: 'src/example.ts',
  line: 4,
  severity: 'P2',
  category: 'correctness',
  message: 'Example finding',
  confidence: 0.9,
  ruleId: 'test-rule',
  status: 'open',
  firstSeenSha: 'base',
  lastSeenSha: 'head',
  ...overrides,
});

test('target selection preserves one, ready, and all command semantics', () => {
  const open = [
    finding({
      fingerprint: 'ready',
      originalCode: 'before',
      fixedCode: 'after',
      githubCommentId: 11,
    }),
    finding({ fingerprint: 'needs-generation', githubCommentId: 12 }),
  ];

  assert.deepEqual(selectTargets(open, { scope: 'one', fingerprint: 'ready' }), [open[0]]);
  assert.deepEqual(selectTargets(open, { scope: 'one', replyToCommentId: 12 }), [open[1]]);
  assert.deepEqual(selectTargets(open, { scope: 'ready' }), [open[0]]);
  assert.deepEqual(selectTargets(open, { scope: 'all' }), open);
});

test('command admission uses the runtime cap and reserves only once', () => {
  let reservations = 0;
  let completed: unknown[] = [];
  const dependencies: AutofixDependencies = {
    github: {} as never,
    standardModel: {} as never,
    maxFileBytes: 1,
    maxFiles: 1,
    createUsageRecorder: () => () => undefined,
    commandLimitReason: () => null,
    store: {
      countAccountCommandRuns: () => 3,
      tryReserveReviewRun: (_input: unknown, limitReason: () => string | null) => {
        reservations += 1;
        assert.equal(limitReason(), 'command_rate_limited');
        return { ok: false, reason: 'command_rate_limited' };
      },
      completeReviewRun: (_runId: string, patch: unknown) => {
        completed.push(patch);
      },
    } as never,
  };

  assert.match(
    commandPrecheck(dependencies, 'acme', 'review', 'tenant-1', runtime) ?? '',
    /3\/hour/,
  );
  const runId = reserveCommandRun(
    dependencies,
    {
      tenantId: 'tenant-1',
      installationId: 1,
      owner: 'acme',
      repo: 'api',
      pr: 7,
      headSha: 'abc',
      action: 'command',
      enqueuedAt: new Date(0).toISOString(),
    },
    'ask',
    'review',
    runtime,
  );
  assert.equal(runId, null);
  assert.equal(reservations, 1);

  completeCommandRun(dependencies, 'run-1', Date.now(), 'completed');
  assert.equal(completed.length, 1);
});
