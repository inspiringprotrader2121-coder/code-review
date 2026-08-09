import type { ReviewFinding } from '@orvex-review/review';
import type { EvalCase } from '../cases.js';
import type { CaseResult } from './types.js';

const SEV_RANK: Record<string, number> = { P1: 3, P2: 2, P3: 1, info: 0 };

/** Scores labels only on the production normal surface; manual findings remain diagnostic. */
export function scoreCase(
  c: EvalCase,
  findings: ReviewFinding[],
  claimed?: Set<ReviewFinding>,
): CaseResult {
  const blob = findings
    .map((finding) => `${finding.severity} ${finding.file} ${finding.message}`)
    .join('\n');
  const missing: string[] = [];
  let recallHits = 0;
  for (const pattern of c.shouldFlag ?? []) {
    if (pattern.test(blob)) recallHits++;
    else missing.push(pattern.source);
  }
  for (const required of c.shouldFlagSevere ?? []) {
    const match = findings.find(
      (finding) =>
        !claimed?.has(finding) &&
        (required.file ? required.file.test(finding.file) : true) &&
        required.pattern.test(`${finding.file} ${finding.message}`.replace(/\s+/g, ' ')) &&
        (SEV_RANK[finding.severity] ?? 0) >= SEV_RANK[required.minSeverity],
    );
    if (match) {
      claimed?.add(match);
      recallHits++;
    } else {
      missing.push(
        `${required.pattern.source} @≥${required.minSeverity}${required.file ? ` in ${required.file.source}` : ''}`,
      );
    }
  }
  const falsePos = (c.shouldNotFlag ?? [])
    .filter((pattern) => pattern.test(blob))
    .map((pattern) => pattern.source);
  return {
    name: c.name,
    findings,
    recallHits,
    recallTotal: (c.shouldFlag ?? []).length + (c.shouldFlagSevere ?? []).length,
    falsePositives: falsePos.length,
    missing,
    falsePos,
  };
}

export function summarizeNormalSurface(
  results: readonly CaseResult[],
  cases: readonly EvalCase[],
): {
  recallHits: number;
  recallTotal: number;
  falsePositives: number;
  falsePositiveChecks: number;
} {
  return {
    recallHits: results.reduce((total, result) => total + result.recallHits, 0),
    recallTotal: results.reduce((total, result) => total + result.recallTotal, 0),
    falsePositives: results.reduce((total, result) => total + result.falsePositives, 0),
    falsePositiveChecks: results.reduce(
      (total, result) =>
        total +
        (cases.find((candidate) => candidate.name === result.name)?.shouldNotFlag?.length ?? 0),
      0,
    ),
  };
}
