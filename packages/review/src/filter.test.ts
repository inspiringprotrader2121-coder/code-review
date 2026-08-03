import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterAndCapFindings } from './filter.js';
import type { ReviewFinding } from './finding.js';

const f = (over: Partial<ReviewFinding>): ReviewFinding => ({
  file: 'a.ts',
  line: 10,
  severity: 'P2',
  category: 'correctness',
  message: 'msg',
  confidence: 0.8,
  ruleId: 'llm.general',
  ...over,
});

const cfg = { max_comments: 25 } as never;

test('TAXONOMY: P1/P2/P3 (Critical/High/MEDIUM) go inline; only info (Low) is folded', () => {
  const { inline, summaryOnly, nitpicks } = filterAndCapFindings(
    [
      f({ severity: 'P1', line: 1 }),
      f({ severity: 'P2', line: 2 }),
      f({ severity: 'P3', line: 3 }), // Medium — a real bug, must surface inline
      f({ severity: 'info', line: 4 }),
    ],
    cfg,
  );
  assert.deepEqual(inline.map((x) => x.severity).sort(), ['P1', 'P2', 'P3']);
  assert.deepEqual(nitpicks.map((x) => x.severity), ['info'], 'only Low/info is folded');
  assert.equal(summaryOnly.length, 0);
});

test('fold_medium:true collapses Medium (P3) alongside Low for a quieter thread', () => {
  const { inline, nitpicks } = filterAndCapFindings(
    [f({ severity: 'P2', line: 2 }), f({ severity: 'P3', line: 3 }), f({ severity: 'info', line: 4 })],
    { max_comments: 25, fold_medium: true } as never,
  );
  assert.deepEqual(inline.map((x) => x.severity), ['P2']);
  assert.deepEqual(nitpicks.map((x) => x.severity).sort(), ['P3', 'info'].sort());
});

test('an actionable finding with no line falls to summaryOnly, not inline; folded unaffected', () => {
  const { inline, summaryOnly, nitpicks } = filterAndCapFindings(
    [f({ severity: 'P2', line: undefined }), f({ severity: 'info', line: 7 })],
    cfg,
  );
  assert.equal(inline.length, 0);
  assert.equal(summaryOnly.length, 1);
  assert.equal(summaryOnly[0].severity, 'P2');
  assert.equal(nitpicks.length, 1);
});

test('max_comments caps actionable inline only — folded notes are never capped away', () => {
  const many = [
    ...Array.from({ length: 5 }, (_, i) => f({ severity: 'P2', line: i + 1 })),
    ...Array.from({ length: 5 }, (_, i) => f({ severity: 'info', line: i + 100 })),
  ];
  const { inline, summaryOnly, nitpicks } = filterAndCapFindings(many, { max_comments: 3 } as never);
  assert.equal(inline.length, 3, 'inline capped to max_comments');
  assert.equal(summaryOnly.length, 2, 'overflow P2s go to summary, not dropped');
  assert.equal(nitpicks.length, 5, 'all folded notes kept, not subject to the inline cap');
});

test('confidence never suppresses or demotes an anchored actionable finding', () => {
  const { inline, summaryOnly } = filterAndCapFindings(
    [
      f({ severity: 'P2', line: 1, confidence: 0.9 }),
      f({ severity: 'P2', line: 2, confidence: 0.01 }),
    ],
    cfg,
  );
  assert.equal(inline.length, 2);
  assert.equal(inline[1].confidence, 0.01);
  assert.equal(summaryOnly.length, 0);
});
