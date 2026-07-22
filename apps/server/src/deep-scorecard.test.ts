import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDeepScorecard, severityCounts } from './deep-scorecard.js';
import type { ScorecardRun } from '@orvex-review/store';

let seq = 0;
const run = (over: Partial<ScorecardRun>): ScorecardRun => ({
  id: `r${++seq}`,
  owner: 'o',
  repo: 'r',
  pr: 1,
  headSha: 'aaa',
  deep: false,
  durationMs: 100_000,
  costUsd: 0.1,
  createdAt: `2026-07-10T10:0${seq}:00Z`,
  newFindings: [],
  ...over,
});

test('THE A/B CASE: normal first then deep on same commit — deep newFindings are marginal', () => {
  const sc = buildDeepScorecard([
    run({ newFindings: [{ severity: 'P2', file: 'a.js' }, { severity: 'P3', file: 'b.js' }] }),
    run({
      deep: true,
      costUsd: 0.5,
      newFindings: [{ severity: 'P1', file: 'mig.sql' }, { severity: 'info', file: 'c.js' }],
    }),
  ]);
  assert.equal(sc.pairs.length, 1);
  assert.deepEqual(sc.pairs[0].normal.found, { P1: 0, P2: 1, P3: 1, info: 0 });
  assert.deepEqual(sc.pairs[0].deepMarginal.found, { P1: 1, P2: 0, P3: 0, info: 1 });
  assert.equal(sc.pairsWhereDeepAddedSevere, 1, 'deep added a P1 → counts as severe-marginal');
  assert.equal(sc.unpairedDeepRuns, 0);
});

test('deep with NO prior normal on the commit is unpaired (its findings are not marginal)', () => {
  const sc = buildDeepScorecard([
    run({ deep: true, newFindings: [{ severity: 'P1', file: 'x.js' }] }),
  ]);
  assert.equal(sc.pairs.length, 0);
  assert.equal(sc.unpairedDeepRuns, 1);
});

test('different commits (or PRs) never pair with each other', () => {
  const sc = buildDeepScorecard([
    run({ headSha: 'aaa' }),
    run({ headSha: 'bbb', deep: true, newFindings: [{ severity: 'P2', file: 'y.js' }] }),
  ]);
  assert.equal(sc.pairs.length, 0, 'normal on aaa must not pair with deep on bbb');
  assert.equal(sc.unpairedDeepRuns, 1);
});

test('deep adding only P3/info does NOT count toward pairsWhereDeepAddedSevere', () => {
  const sc = buildDeepScorecard([
    run({ newFindings: [{ severity: 'P1', file: 'a.js' }] }),
    run({ deep: true, newFindings: [{ severity: 'P3', file: 'b.js' }, { severity: 'info', file: 'c.js' }] }),
  ]);
  assert.equal(sc.pairs.length, 1);
  assert.equal(sc.pairsWhereDeepAddedSevere, 0, 'P3/info marginal is not "more serious bugs"');
});

test('totals: averages split by run type', () => {
  const sc = buildDeepScorecard([
    run({ costUsd: 0.1, durationMs: 100_000 }),
    run({ costUsd: 0.3, durationMs: 200_000 }),
    run({ deep: true, costUsd: 0.5, durationMs: 400_000 }),
  ]);
  assert.equal(sc.totals.normalRuns, 2);
  assert.equal(sc.totals.deepRuns, 1);
  assert.ok(Math.abs(sc.totals.avgCostNormal - 0.2) < 1e-9);
  assert.equal(sc.totals.avgCostDeep, 0.5);
  assert.equal(sc.totals.avgDurationSDeep, 400);
});

test('severityCounts maps unknown severities to info', () => {
  assert.deepEqual(severityCounts([{ severity: 'weird' }, { severity: 'P1' }]), {
    P1: 1,
    P2: 0,
    P3: 0,
    info: 1,
  });
});
