import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyVerdicts,
  isProtectedSourceTier,
  isWeakVerifierTier,
  partitionVerifiedFindings,
  parsePositiveIntEnv,
  shouldRescueHedgedRejection,
} from './verifier.js';
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

test('missing verdicts are unverified, not silently confirmed; escalate still works', () => {
  const findings = [finding({ line: 1, severity: 'P2' }), finding({ line: 2 })];
  const out = applyVerdicts(findings, {
    verdicts: [{ id: 0, verdict: 'confirmed', severity: 'P1' }],
  });
  assert.equal(out.kept.length, 1);
  assert.equal(out.kept[0].severity, 'P1', 'verifier may RAISE severity');
  assert.equal(out.unverified.length, 1, 'missing verdict must not confirm');
  assert.equal(out.unverified[0].line, 2);
});

test('evidence-gated P1→P2 is applied; bare demotion and P1→P3 are ignored', () => {
  const findings = [
    finding({ line: 1, severity: 'P1', message: 'ui throw' }),
    finding({ line: 2, severity: 'P1', message: 'no evidence' }),
    finding({ line: 3, severity: 'P1', message: 'too far' }),
  ];
  const out = applyVerdicts(findings, {
    verdicts: [
      {
        id: 0,
        verdict: 'confirmed',
        severity: 'P2',
        severityEvidence: 'UI ReferenceError only; not security/data-loss/outage',
      },
      { id: 1, verdict: 'confirmed', severity: 'P2' },
      { id: 2, verdict: 'confirmed', severity: 'P3', severityEvidence: 'would wrongly weaken' },
    ],
  });
  assert.equal(out.kept[0].severity, 'P2');
  assert.match(out.kept[0].severityReason ?? '', /UI ReferenceError/);
  assert.equal(out.kept[1].severity, 'P1', 'no evidence → keep P1');
  assert.equal(out.kept[2].severity, 'P1', 'P1→P3 ignored');
});

test('a duplicate cannot undo an evidence-gated P1→P2 demotion on the kept finding', () => {
  const findings = [
    finding({ line: 1, severity: 'P1', message: 'ui throw' }),
    finding({ line: 2, severity: 'P1', message: 'same ui throw elsewhere' }),
  ];
  const out = applyVerdicts(findings, {
    verdicts: [
      {
        id: 0,
        verdict: 'confirmed',
        severity: 'P2',
        severityEvidence: 'UI only; not security/data-loss/outage',
      },
      { id: 1, verdict: 'confirmed', duplicateOf: 0 },
    ],
  });
  assert.equal(out.kept.length, 1);
  assert.equal(out.kept[0].severity, 'P2', 'evidence demotion must survive duplicate fold-up');
  assert.match(out.kept[0].severityReason ?? '', /UI only/);
  assert.equal(out.duplicates.length, 1);
});

test('DeepSeek Flash receives the same hedged-veto protection as the other strong sources', () => {
  for (const tier of ['openai', 'deepseek', 'deepseek-flash', 'deterministic']) {
    assert.equal(isProtectedSourceTier(tier), true, `${tier} must be protected`);
  }
  for (const tier of [undefined, 'standard', 'premium', 'unknown']) {
    assert.equal(isProtectedSourceTier(tier), false, `${tier ?? 'undefined'} must use the normal verifier gate`);
  }
});

test('hedge rescue only when the verifier is weak (not peer/same-family)', () => {
  assert.equal(isWeakVerifierTier('standard'), true);
  assert.equal(isWeakVerifierTier(undefined), true);
  assert.equal(isWeakVerifierTier('openai'), false);
  assert.equal(isWeakVerifierTier('deepseek'), false);

  assert.equal(
    shouldRescueHedgedRejection('openai', 'cannot independently verify this from the code shown', 'standard'),
    true,
  );
  assert.equal(
    shouldRescueHedgedRejection('openai', 'cannot independently verify this from the code shown', 'openai'),
    false,
    'Luna must not rescue Luna hedges',
  );
  assert.equal(
    shouldRescueHedgedRejection('openai', 'cannot independently verify this from the code shown', 'deepseek'),
    false,
    'peer-strength DeepSeek must not rescue Luna hedges',
  );
});

test('verification demotes rejected candidates instead of deleting them after the pass union', () => {
  const confirmed = finding({ message: 'confirmed finding', sourceTier: 'standard' });
  const normal = finding({ message: 'normal rejection', sourceTier: 'standard' });
  const flash = finding({ message: 'flash hedge', sourceTier: 'deepseek-flash' });
  const factual = finding({ message: 'flash factual refutation', sourceTier: 'deepseek-flash' });
  const manual = finding({ message: 'manual recurrence candidate', confidence: 0.3 });
  const out = partitionVerifiedFindings(
    [confirmed, normal, flash, factual],
    [{ finding: manual, reason: 'Seen in only one repeated review sample.' }],
    {
      status: 'verified',
      kept: [confirmed, manual],
      dropped: [
        { finding: normal, reason: 'the finding is not supported by the source' },
        { finding: flash, reason: 'cannot independently verify this from the code shown' },
        { finding: factual, reason: 'the function returns early when user is null; the described failure is impossible' },
      ],
      duplicates: [],
      unverified: [],
    },
    { verifierTier: 'standard' },
  );

  assert.deepEqual(
    out.toPost.map((f) => f.message).sort(),
    ['confirmed finding', 'flash hedge'].sort(),
    'confirmed findings and hedged protected rejections stay on the normal surface under a weak verifier',
  );
  assert.equal(out.rescued.length, 1);
  assert.equal(out.refuted.length, 1, 'factual protected refutations are not restored as confirmed');
  assert.deepEqual(
    out.reviewOnly.map((item) => item.finding.message).sort(),
    ['flash factual refutation', 'manual recurrence candidate', 'normal rejection'].sort(),
    'ordinary and factual verifier rejections remain visible for manual review',
  );
  assert.match(
    out.reviewOnly.find((item) => item.finding.message === 'flash factual refutation')!.reason,
    /Verifier did not confirm/,
  );
});

test('peer verifier hedges of protected sources go to manual, not rescue', () => {
  const luna = finding({ message: 'luna hedge', severity: 'P2', sourceTier: 'openai' });
  const out = partitionVerifiedFindings(
    [luna],
    [],
    {
      status: 'verified',
      kept: [],
      dropped: [{ finding: luna, reason: 'cannot independently verify this from the code shown' }],
      duplicates: [],
      unverified: [],
    },
    { verifierTier: 'deepseek' },
  );
  assert.equal(out.toPost.length, 0);
  assert.equal(out.rescued.length, 0);
  assert.equal(out.reviewOnly.length, 1);
  assert.match(out.reviewOnly[0].reason, /Peer verifier hedged/);
});

test('unavailable verification preserves P1/P2 and demotes weaker severities', () => {
  const p1 = finding({ message: 'real p1', severity: 'P1' });
  const p3 = finding({ message: 'smell', severity: 'P3' });
  const out = partitionVerifiedFindings(
    [p1, p3],
    [],
    {
      status: 'unavailable',
      unavailableReason: 'TPM exhausted',
      kept: [],
      dropped: [],
      duplicates: [],
      unverified: [p1, p3],
    },
  );
  assert.equal(out.verificationIncomplete, true);
  assert.deepEqual(out.toPost.map((f) => f.message), ['real p1']);
  assert.equal(out.reviewOnly.length, 1);
  assert.match(out.reviewOnly[0].reason, /TPM exhausted/);
});

test('partial verification keeps confirmed verdicts but marks incomplete', () => {
  const confirmed = finding({ message: 'confirmed bug', severity: 'P2' });
  const missed = finding({ message: 'batch failed', severity: 'P2', line: 2 });
  const out = partitionVerifiedFindings(
    [confirmed, missed],
    [],
    {
      status: 'partial',
      unavailableReason: 'batch 2 failed',
      kept: [confirmed],
      dropped: [],
      duplicates: [],
      unverified: [missed],
    },
  );
  assert.equal(out.toPost.length, 2);
  assert.equal(out.verificationIncomplete, true);
  assert.match(out.unavailableReason ?? '', /batch 2 failed/);
});

test('parsePositiveIntEnv rejects NaN and non-positive values', () => {
  assert.equal(parsePositiveIntEnv(undefined, 10), 10);
  assert.equal(parsePositiveIntEnv('abc', 10), 10);
  assert.equal(parsePositiveIntEnv('0', 10), 10);
  assert.equal(parsePositiveIntEnv('-5', 10), 10);
  assert.equal(parsePositiveIntEnv('42', 10), 42);
});
