import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyVerdicts, isProtectedSourceTier, partitionVerifiedFindings } from './verifier.js';
import type { ReviewFinding } from './finding.js';

const finding = (over: Partial<ReviewFinding>): ReviewFinding => ({
  file: 'a.js',
  line: 10,
  severity: 'P3',
  category: 'correctness',
  message: 'msg',
  confidence: 0.8,
  ruleId: 'llm.general',
  ...over,
});

test('duplicateOf merges a same-file confirmed copy and keeps the root cause once', () => {
  const findings = [
    finding({ line: 395, severity: 'P1', message: 'check.ok overwritten (loop)' }),
    finding({ line: 413, severity: 'P2', message: 'check.ok overwritten (overwrite site)' }),
  ];
  const out = applyVerdicts(findings, {
    verdicts: [
      { id: 0, verdict: 'confirmed' },
      { id: 1, verdict: 'confirmed', duplicateOf: 0 },
    ],
  });
  assert.equal(out.kept.length, 1);
  assert.equal(out.kept[0].line, 395);
  assert.equal(out.duplicates.length, 1);
  assert.equal(out.duplicates[0].finding.line, 413);
  assert.equal(out.dropped.length, 0);
});

test('duplicate severity folds UP into the kept finding (max of the cluster)', () => {
  const findings = [
    finding({ line: 1, severity: 'P3' }),
    finding({ line: 2, severity: 'P1' }),
  ];
  const out = applyVerdicts(findings, {
    verdicts: [
      { id: 0, verdict: 'confirmed' },
      { id: 1, verdict: 'confirmed', duplicateOf: 0 },
    ],
  });
  assert.equal(out.kept.length, 1);
  assert.equal(out.kept[0].severity, 'P1', 'kept finding takes the max severity of the cluster');
});

test('CROSS-FILE duplicateOf is IGNORED — two files may hold two distinct instances', () => {
  const findings = [
    finding({ file: 'a.js', line: 1 }),
    finding({ file: 'b.js', line: 1 }),
  ];
  const out = applyVerdicts(findings, {
    verdicts: [
      { id: 0, verdict: 'confirmed' },
      { id: 1, verdict: 'confirmed', duplicateOf: 0 },
    ],
  });
  assert.equal(out.kept.length, 2, 'cross-file duplicate marking must not merge');
  assert.equal(out.duplicates.length, 0);
});

test('duplicateOf pointing at a REJECTED finding keeps this one (never lose the bug entirely)', () => {
  const findings = [finding({ line: 1 }), finding({ line: 2 })];
  const out = applyVerdicts(findings, {
    verdicts: [
      { id: 0, verdict: 'rejected', reason: 'wrong' },
      { id: 1, verdict: 'confirmed', duplicateOf: 0 },
    ],
  });
  assert.equal(out.kept.length, 1);
  assert.equal(out.kept[0].line, 2);
  assert.equal(out.duplicates.length, 0);
});

test('self-referencing and missing verdicts stay kept; severity never downgrades', () => {
  const findings = [finding({ line: 1, severity: 'P1' }), finding({ line: 2 })];
  const out = applyVerdicts(findings, {
    verdicts: [{ id: 0, verdict: 'confirmed', severity: 'P3', duplicateOf: 0 }],
  });
  assert.equal(out.kept.length, 2, 'no verdict = fail open; self-dup ignored');
  assert.equal(out.kept[0].severity, 'P1', 'verifier may not LOWER severity');
});

test('DeepSeek Flash receives the same hedged-veto protection as the other strong sources', () => {
  for (const tier of ['openai', 'deepseek', 'deepseek-flash', 'deterministic']) {
    assert.equal(isProtectedSourceTier(tier), true, `${tier} must be protected`);
  }
  for (const tier of [undefined, 'standard', 'premium', 'unknown']) {
    assert.equal(isProtectedSourceTier(tier), false, `${tier ?? 'undefined'} must use the normal verifier gate`);
  }
});

test('verification demotes rejected candidates instead of deleting them after the pass union', () => {
  const confirmed = finding({ message: 'confirmed finding', sourceTier: 'standard' });
  const normal = finding({ message: 'normal rejection', sourceTier: 'standard' });
  const flash = finding({ message: 'flash hedge', sourceTier: 'deepseek-flash' });
  const factual = finding({ message: 'flash factual refutation', sourceTier: 'deepseek-flash' });
  const low = finding({ message: 'low confidence candidate', confidence: 0.3 });
  const out = partitionVerifiedFindings(
    [confirmed, normal, flash, factual],
    [{ finding: low, reason: 'Model confidence 0.30 is below the configured confirmation floor (0.60).' }],
    {
      kept: [confirmed, low],
      dropped: [
        { finding: normal, reason: 'the finding is not supported by the source' },
        { finding: flash, reason: 'cannot independently verify this from the code shown' },
        { finding: factual, reason: 'the function returns early when user is null; the described failure is impossible' },
      ],
      duplicates: [],
    },
  );

  assert.deepEqual(
    out.toPost.map((f) => f.message).sort(),
    ['confirmed finding', 'flash hedge'].sort(),
    'confirmed findings and hedged protected rejections stay on the normal surface',
  );
  assert.equal(out.rescued.length, 1);
  assert.equal(out.refuted.length, 1, 'factual protected refutations are not restored as confirmed');
  assert.deepEqual(
    out.reviewOnly.map((item) => item.finding.message).sort(),
    ['flash factual refutation', 'low confidence candidate', 'normal rejection'].sort(),
    'ordinary and factual verifier rejections remain visible for manual review',
  );
  assert.match(
    out.reviewOnly.find((item) => item.finding.message === 'flash factual refutation')!.reason,
    /Verifier did not confirm/,
  );
});
