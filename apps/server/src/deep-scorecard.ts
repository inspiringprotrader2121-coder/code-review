import type { ScorecardRun } from '@orvex-review/store';

/**
 * Deep-vs-normal scorecard (ROADMAP Phase 3.4 — "deep must EARN its 2× price").
 *
 * The measurement rides on the A/B protocol: run `@orvex review` (normal)
 * first, then `@orvex deep` on the SAME commit. Carry-forward dedup means the
 * deep run only posts what normal missed — so a paired deep run's newFindings
 * are exactly its marginal value, no attribution model needed.
 *
 * Pure function over ScorecardRun rows so the math is unit-testable.
 */

export interface SeverityCounts {
  P1: number;
  P2: number;
  P3: number;
  info: number;
}

export interface DeepPair {
  owner: string;
  repo: string;
  pr: number;
  headSha: string;
  normal: { runs: number; found: SeverityCounts; costUsd: number };
  /** what the deep run(s) added AFTER a completed normal on the same commit */
  deepMarginal: { runs: number; found: SeverityCounts; costUsd: number };
}

export interface DeepScorecard {
  generatedAt: string;
  totals: {
    normalRuns: number;
    deepRuns: number;
    avgCostNormal: number;
    avgCostDeep: number;
    avgDurationSNormal: number;
    avgDurationSDeep: number;
    avgNewFindingsNormal: number;
    avgNewFindingsDeep: number;
  };
  /** commits where the A/B protocol ran (normal first, deep after) */
  pairs: DeepPair[];
  /** headline: on how many paired commits did deep add >=1 P1/P2 beyond normal */
  pairsWhereDeepAddedSevere: number;
  /** deep runs with no prior normal on the commit — real runs, but their
   *  findings are not marginal (they include what a normal run would find) */
  unpairedDeepRuns: number;
}

export function severityCounts(findings: Array<{ severity: string }>): SeverityCounts {
  const counts: SeverityCounts = { P1: 0, P2: 0, P3: 0, info: 0 };
  for (const f of findings) {
    if (f.severity === 'P1') counts.P1++;
    else if (f.severity === 'P2') counts.P2++;
    else if (f.severity === 'P3') counts.P3++;
    else counts.info++;
  }
  return counts;
}

const addCounts = (a: SeverityCounts, b: SeverityCounts): SeverityCounts => ({
  P1: a.P1 + b.P1,
  P2: a.P2 + b.P2,
  P3: a.P3 + b.P3,
  info: a.info + b.info,
});

/** `runs` must be oldest-first (listScorecardRuns guarantees it). */
export function buildDeepScorecard(runs: ScorecardRun[]): DeepScorecard {
  const normals = runs.filter((r) => !r.deep);
  const deeps = runs.filter((r) => r.deep);
  const avg = (xs: number[]) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

  // group by commit
  const byCommit = new Map<string, ScorecardRun[]>();
  for (const r of runs) {
    const key = `${r.owner}/${r.repo}#${r.pr}@${r.headSha}`;
    const list = byCommit.get(key) ?? [];
    list.push(r);
    byCommit.set(key, list);
  }

  const pairs: DeepPair[] = [];
  let unpairedDeepRuns = 0;
  for (const group of byCommit.values()) {
    const deepRuns = group.filter((r) => r.deep);
    if (deepRuns.length === 0) continue;
    // paired = a normal run COMPLETED before the first deep run on this commit
    const firstDeepAt = deepRuns[0].createdAt;
    const normalsBefore = group.filter((r) => !r.deep && r.createdAt < firstDeepAt);
    if (normalsBefore.length === 0) {
      unpairedDeepRuns += deepRuns.length;
      continue;
    }
    const { owner, repo, pr, headSha } = deepRuns[0];
    pairs.push({
      owner,
      repo,
      pr,
      headSha,
      normal: {
        runs: normalsBefore.length,
        found: normalsBefore.map((r) => severityCounts(r.newFindings)).reduce(addCounts),
        costUsd: normalsBefore.reduce((s, r) => s + r.costUsd, 0),
      },
      deepMarginal: {
        runs: deepRuns.length,
        found: deepRuns.map((r) => severityCounts(r.newFindings)).reduce(addCounts),
        costUsd: deepRuns.reduce((s, r) => s + r.costUsd, 0),
      },
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    totals: {
      normalRuns: normals.length,
      deepRuns: deeps.length,
      avgCostNormal: avg(normals.map((r) => r.costUsd)),
      avgCostDeep: avg(deeps.map((r) => r.costUsd)),
      avgDurationSNormal: avg(normals.map((r) => r.durationMs / 1000)),
      avgDurationSDeep: avg(deeps.map((r) => r.durationMs / 1000)),
      avgNewFindingsNormal: avg(normals.map((r) => r.newFindings.length)),
      avgNewFindingsDeep: avg(deeps.map((r) => r.newFindings.length)),
    },
    pairs,
    pairsWhereDeepAddedSevere: pairs.filter(
      (p) => p.deepMarginal.found.P1 + p.deepMarginal.found.P2 > 0,
    ).length,
    unpairedDeepRuns,
  };
}
