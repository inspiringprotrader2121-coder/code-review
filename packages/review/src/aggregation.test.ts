import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  aggregateRepeatedFindings,
  fitReviewAggregationToBudget,
  readReviewAggregationConfig,
  type RepeatedFinding,
} from './aggregation.js';
import type { ReviewFinding } from './finding.js';

const finding = (over: Partial<ReviewFinding> = {}): ReviewFinding => ({
  file: 'src/service.ts',
  line: 12,
  severity: 'P2',
  category: 'correctness',
  message: 'The retry path leaks its reservation after a failed request.',
  confidence: 0.7,
  ruleId: 'llm.correctness',
  ...over,
});

test('aggregation is off by default and only permits five to ten repeated samples', () => {
  assert.equal(readReviewAggregationConfig({}).enabled, false);
  const tooSmall = readReviewAggregationConfig({ ORVEX_REVIEW_AGGREGATION_RUNS: '4' });
  assert.equal(tooSmall.enabled, false);
  assert.match(tooSmall.disabledReason ?? '', /1 \(off\) or between 5 and 10/);

  const bounded = readReviewAggregationConfig({
    ORVEX_REVIEW_AGGREGATION_RUNS: '12',
    ORVEX_REVIEW_AGGREGATION_MIN_OCCURRENCES: '1',
    ORVEX_REVIEW_AGGREGATION_TEMPERATURE: '3',
    ORVEX_REVIEW_AGGREGATION_MAX_CANDIDATES: '999',
  });
  assert.equal(bounded.enabled, true);
  assert.equal(bounded.runs, 10);
  assert.equal(bounded.minOccurrences, 2);
  assert.equal(bounded.temperature, 1);
  assert.equal(bounded.maxCandidates, 250);
});

test('aggregation falls back to one normal review when the call budget cannot fund five complete samples', () => {
  const configured = readReviewAggregationConfig({ ORVEX_REVIEW_AGGREGATION_RUNS: '5' });
  const unsupported = fitReviewAggregationToBudget(configured, 4, 28, 12);
  assert.equal(unsupported.enabled, false);
  assert.equal(unsupported.effectiveRuns, 1);

  const supported = fitReviewAggregationToBudget(configured, 4, 28, 4);
  assert.equal(supported.enabled, true);
  assert.equal(supported.effectiveRuns, 5);
});

test('LLM-merged findings require recurrence while one-off candidates remain visible for manual review', async () => {
  const entries: RepeatedFinding[] = [
    { sample: 0, finding: finding() },
    {
      sample: 1,
      finding: finding({
        line: 16,
        severity: 'P1',
        confidence: 0.9,
        message: 'On retry failure, the reservation is never released and can exhaust the account quota.',
      }),
    },
    { sample: 2, finding: finding({ file: 'src/other.ts', message: 'One-off independent candidate.' }) },
  ];
  const result = await aggregateRepeatedFindings(entries, {
    minOccurrences: 2,
    maxCandidates: 20,
    mergeWithLlm: async () => JSON.stringify({ clusters: [{ representative: 1, members: [0, 1] }, { representative: 2, members: [2] }] }),
  });

  assert.equal(result.usedLlmMerge, true);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].severity, 'P1', 'a merged cluster preserves the highest supported severity');
  assert.equal(result.reviewOnly.length, 1);
  assert.match(result.reviewOnly[0].reason, /1 of the required 2/);
});

test('a merger-selected weak anchor cannot inherit another finding\'s severity', async () => {
  const entries: RepeatedFinding[] = [
    {
      sample: 0,
      finding: finding({
        line: 4,
        severity: 'P3',
        confidence: 0.2,
        message: 'A vague observation at a weak anchor.',
      }),
    },
    {
      sample: 1,
      finding: finding({
        line: 28,
        severity: 'P1',
        confidence: 0.95,
        message: 'The retry can exhaust every account reservation after a concrete failure.',
      }),
    },
  ];
  const result = await aggregateRepeatedFindings(entries, {
    minOccurrences: 2,
    maxCandidates: 20,
    mergeWithLlm: async () => JSON.stringify({ clusters: [{ representative: 0, members: [0, 1] }] }),
  });

  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].line, 28);
  assert.equal(result.findings[0].severity, 'P1');
  assert.match(result.findings[0].message, /exhaust every account reservation/);
});

test('a malformed or cross-file LLM merge cannot erase candidates', async () => {
  const entries: RepeatedFinding[] = [
    { sample: 0, finding: finding({ file: 'src/a.ts' }) },
    { sample: 1, finding: finding({ file: 'src/b.ts' }) },
  ];
  const result = await aggregateRepeatedFindings(entries, {
    minOccurrences: 2,
    maxCandidates: 20,
    mergeWithLlm: async () => JSON.stringify({ clusters: [{ representative: 0, members: [0, 1] }] }),
  });

  assert.equal(result.usedLlmMerge, true);
  assert.equal(result.findings.length, 0, 'cross-file candidates must not be merged into a normal finding');
  assert.equal(result.reviewOnly.length, 2, 'every rejected merge member remains visible');
});

test('an exact match beyond the bounded merger input still counts toward recurrence', async () => {
  const entries: RepeatedFinding[] = [
    { sample: 0, finding: finding() },
    { sample: 1, finding: finding() },
  ];
  const result = await aggregateRepeatedFindings(entries, {
    minOccurrences: 2,
    maxCandidates: 1,
    mergeWithLlm: async () => JSON.stringify({ clusters: [{ representative: 0, members: [0] }] }),
  });

  assert.equal(result.findings.length, 1);
  assert.equal(result.reviewOnly.length, 0);
  assert.equal(result.clusterCount, 1);
});
