import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  collapseSameDefect,
  dedupeByFileLine,
  filterAndCapFindings,
  hasConcreteFailurePath,
} from './filter.js';
import type { ReviewFinding } from './finding.js';

const f = (over: Partial<ReviewFinding>): ReviewFinding => ({
  file: 'a.ts',
  line: 10,
  severity: 'P2',
  category: 'correctness',
  // Default to a message that states a trigger and an outcome.
  message:
    "When the request arrives without a tenant scope, the lookup returns another tenant's record.",
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
  assert.deepEqual(
    nitpicks.map((x) => x.severity),
    ['info'],
    'only Low/info is folded',
  );
  assert.equal(summaryOnly.length, 0);
});

test('fold_medium:true collapses Medium (P3) alongside Low for a quieter thread', () => {
  const { inline, nitpicks } = filterAndCapFindings(
    [
      f({ severity: 'P2', line: 2 }),
      f({ severity: 'P3', line: 3 }),
      f({ severity: 'info', line: 4 }),
    ],
    { max_comments: 25, fold_medium: true } as never,
  );
  assert.deepEqual(
    inline.map((x) => x.severity),
    ['P2'],
  );
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
  const { inline, summaryOnly, nitpicks } = filterAndCapFindings(many, {
    max_comments: 3,
  } as never);
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

test('same-line dedupe preserves provenance from every corroborating pass', () => {
  const [merged] = dedupeByFileLine([
    f({
      sourceTier: 'standard',
      sourcePass: 'general',
      message: 'first pass found the defect',
    }),
    f({
      sourceTier: 'deepseek-flash',
      sourcePass: 'deep-dive',
      message: 'more detailed second pass found the defect',
    }),
  ]);
  assert.equal(merged.provenance?.length, 2);
  assert.deepEqual(merged.provenance?.map((item) => item.sourcePass).sort(), [
    'deep-dive',
    'general',
  ]);
});

test('collapseSameDefect: one defect reported at two lines becomes one comment', () => {
  // Both halves of this pair were posted on PR #231 as separate inline comments.
  const kept = collapseSameDefect([
    f({
      file: 'ApiDocs.jsx',
      line: 42,
      severity: 'P2',
      message:
        'The public API page now advertises `PUT /{slug}/api/lines/{id}`, but ' +
        '`backend/src/openapi.yaml` no longer defines any such operation.',
    }),
    f({
      file: 'ApiDocs.jsx',
      line: 48,
      severity: 'P1',
      message:
        'The page advertises `PUT /{slug}/api/lines/{id}`, but the revised OpenAPI ' +
        'document has no corresponding path entry.',
    }),
  ]);
  assert.equal(kept.length, 1);
  // Highest severity survives, so collapsing can never quietly downgrade a bug.
  assert.equal(kept[0].severity, 'P1');
  assert.ok((kept[0].provenance?.length ?? 0) >= 2);
});

test('collapseSameDefect: distinct defects in one file both survive', () => {
  const kept = collapseSameDefect([
    f({
      file: 'a.ts',
      line: 10,
      message: 'The rate limiter permits a burst past the documented quota.',
    }),
    f({
      file: 'a.ts',
      line: 40,
      message: 'Timestamps are stored without a timezone, so the audit trail is off by hours.',
    }),
  ]);
  assert.equal(kept.length, 2);
});

test('collapseSameDefect: findings in different files never merge', () => {
  const message = 'The `paginateExportRows` cursor can exceed `GDPR_EXPORT_MAX_OFFSET`.';
  const kept = collapseSameDefect([
    f({ file: 'routes/gdpr.js', line: 70, message }),
    f({ file: 'repositories/gdpr.js', line: 70, message }),
  ]);
  assert.equal(kept.length, 2);
});

test('collapseSameDefect: unanchored findings are left alone', () => {
  const message = 'The `paginateExportRows` cursor can exceed `GDPR_EXPORT_MAX_OFFSET`.';
  const kept = collapseSameDefect([
    f({ file: 'gdpr.js', line: undefined, message }),
    f({ file: 'gdpr.js', line: 70, message }),
  ]);
  assert.equal(kept.length, 2);
});

test('hasConcreteFailurePath: a stated trigger and outcome passes; an assertion does not', () => {
  assert.equal(
    hasConcreteFailurePath(
      'When a retry runs after the redemption row already exists, `incrementUsedCountIfAllowed` ' +
        'is skipped, so the coupon usage counter never increments and the limit can be exceeded.',
    ),
    true,
  );
  assert.equal(
    hasConcreteFailurePath(
      'This validation pattern is risky and inconsistent with the rest of the codebase; consider ' +
        'extracting it into a shared helper for maintainability and clarity going forward.',
    ),
    false,
  );
});

test('lined findings stay on the diff even when the message is observational', () => {
  const vague =
    'This pattern is risky and inconsistent with the surrounding code; a shared helper would read better here.';
  const { inline, summaryOnly } = filterAndCapFindings(
    [
      f({ severity: 'P1', line: 1, message: vague }),
      f({ severity: 'P2', line: 2, message: vague }),
      f({ severity: 'P3', line: 3, message: vague }),
      f({ severity: 'P2', line: undefined, message: vague }),
    ],
    cfg,
  );
  assert.deepEqual(
    inline.map((x) => x.line),
    [1, 2, 3],
  );
  assert.equal(summaryOnly.length, 1);
  assert.equal(summaryOnly[0]?.line, undefined);
});
