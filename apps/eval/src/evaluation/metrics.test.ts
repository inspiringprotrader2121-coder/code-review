import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EvalCase } from '../cases.js';
import { scoreCase, summarizeNormalSurface } from './metrics.js';

const caseWithLabels: EvalCase = {
  name: 'metrics-boundary',
  owner: 'owner',
  repo: 'repo',
  pr: 1,
  baseSha: 'a'.repeat(40),
  sha: 'b'.repeat(40),
  evidence: { path: 'src/example.ts', line: 1, outcome: 'confirmed' },
  shouldFlagSevere: [
    { pattern: /missing authorization/i, minSeverity: 'P2', file: /example\.ts$/ },
  ],
  shouldNotFlag: [/unrelated warning/i],
};

test('normal-surface metrics require the labelled severity and do not reuse a finding', () => {
  const findings = [
    {
      file: 'src/example.ts',
      severity: 'P2' as const,
      category: 'security',
      message: 'missing authorization permits cross-tenant access',
      confidence: 0.9,
    },
  ];
  const claimed = new Set<(typeof findings)[number]>();
  const first = scoreCase(caseWithLabels, findings, claimed);
  const second = scoreCase(caseWithLabels, findings, claimed);
  assert.equal(first.recallHits, 1);
  assert.equal(second.recallHits, 0);
  assert.equal(second.missing.length, 1);
});

test('summary only combines supplied normal-surface results', () => {
  const normal = scoreCase(caseWithLabels, [
    {
      file: 'src/example.ts',
      severity: 'P2',
      category: 'security',
      message: 'missing authorization permits cross-tenant access',
      confidence: 0.9,
    },
  ]);
  const summary = summarizeNormalSurface([normal], [caseWithLabels]);
  assert.deepEqual(summary, {
    recallHits: 1,
    recallTotal: 1,
    falsePositives: 0,
    falsePositiveChecks: 1,
  });
});
