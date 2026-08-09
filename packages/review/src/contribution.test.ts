import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatModelContribution, summarizeModelContribution } from './contribution.js';
import type { ReviewFinding } from './finding.js';

const f = (over: Partial<ReviewFinding>): ReviewFinding => ({
  file: 'a.ts',
  line: 1,
  severity: 'P2',
  category: 'correctness',
  message: 'bug',
  confidence: 0.8,
  ruleId: 'llm.general',
  ...over,
});

test('summarizeModelContribution counts shared vs unique fingerprints per tier', () => {
  const findings = [
    f({ message: 'only flash', sourceTier: 'deepseek-flash', sourcePass: 'deep-dive' }),
    f({
      message: 'only pro',
      sourceTier: 'deepseek',
      sourcePass: 'removed-behavior/callers',
      line: 2,
    }),
    f({ message: 'shared bug', sourceTier: 'deepseek-flash', sourcePass: 'deep-dive', line: 3 }),
    f({
      message: 'shared bug',
      sourceTier: 'openai',
      sourcePass: 'general',
      line: 3,
      ruleId: 'llm.general',
    }),
  ];
  const report = summarizeModelContribution(findings);
  assert.equal(report.total, 3);
  const flash = report.byTier.find((r) => r.key === 'deepseek-flash')!;
  const pro = report.byTier.find((r) => r.key === 'deepseek')!;
  const openai = report.byTier.find((r) => r.key === 'openai')!;
  assert.equal(flash.count, 2);
  assert.equal(flash.uniqueCount, 1);
  assert.equal(pro.count, 1);
  assert.equal(pro.uniqueCount, 1);
  assert.equal(openai.count, 1);
  assert.equal(openai.uniqueCount, 0);
  assert.match(formatModelContribution(report), /deepseek-flash:2 \(1 unique\)/);
  assert.match(formatModelContribution(report), /lenses:/);
  const deepDive = report.byPass.find((r) => r.key === 'deep-dive')!;
  assert.equal(deepDive.count, 2);
  assert.equal(deepDive.uniqueCount, 1);
});

test('Flash on two lenses still separates unique contribution by sourcePass', () => {
  const findings = [
    f({ message: 'deep dive only', sourceTier: 'deepseek-flash', sourcePass: 'deep-dive' }),
    f({
      message: 'caller only',
      sourceTier: 'deepseek-flash',
      sourcePass: 'removed-behavior/callers',
      line: 2,
    }),
    f({
      message: 'both lenses',
      sourceTier: 'deepseek-flash',
      sourcePass: 'deep-dive',
      line: 3,
    }),
    f({
      message: 'both lenses',
      sourceTier: 'deepseek-flash',
      sourcePass: 'removed-behavior/callers',
      line: 3,
    }),
  ];
  const report = summarizeModelContribution(findings);
  // Same tier → byTier unique collapses; byPass keeps the signal.
  const flash = report.byTier.find((r) => r.key === 'deepseek-flash')!;
  assert.equal(flash.count, 3);
  assert.equal(flash.uniqueCount, 3);
  const callers = report.byPass.find((r) => r.key === 'removed-behavior/callers')!;
  assert.equal(callers.count, 2);
  assert.equal(callers.uniqueCount, 1);
});
