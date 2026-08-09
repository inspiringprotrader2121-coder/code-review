import fs from 'node:fs';
import path from 'node:path';
import {
  CASES,
  evaluationCorpusFingerprint,
  evaluationCorpusLabelCounts,
  type EvalCase,
} from '../cases.js';
import { assertCanonicalGoldCorpus } from '../corpus-manifest.js';
import {
  EvaluationRequestBudget,
  requireLiveCaseLimit,
  requireLiveEvaluationControls,
} from '../live-controls.js';
import {
  evaluationConfigurationFingerprint,
  evaluationModelConfiguration,
} from './configuration.js';
import { scoreCase, summarizeNormalSurface } from './metrics.js';
import { reviewPr } from './review-pr.js';
import type { CaseResult, EvaluationLogger } from './types.js';

function caseGroups(cases: readonly EvalCase[]): Map<string, EvalCase[]> {
  const groups = new Map<string, EvalCase[]>();
  for (const evaluationCase of cases) {
    const key = `${evaluationCase.owner}/${evaluationCase.repo}#${evaluationCase.pr}@${evaluationCase.baseSha}...${evaluationCase.sha}`;
    const group = groups.get(key) ?? [];
    group.push(evaluationCase);
    groups.set(key, group);
  }
  return groups;
}

export interface ControlledEvaluationResult {
  results: CaseResult[];
  invalidCases: number;
  degradedRuns: number;
  manualCandidateCount: number;
}

/**
 * Runs only after the explicit live controls have been supplied. This function is
 * deliberately not called at import time, so tests and tooling make no provider calls.
 */
export async function runControlledEvaluation(
  only: string | undefined = process.argv[2],
  env: NodeJS.ProcessEnv = process.env,
  logger: EvaluationLogger = { log: (message) => console.log(message) },
): Promise<ControlledEvaluationResult> {
  const selectedCases = only
    ? CASES.filter((evaluationCase) => evaluationCase.name.includes(only))
    : CASES;
  const controls = requireLiveEvaluationControls(env);
  requireLiveCaseLimit(selectedCases.length, env);
  const budget = new EvaluationRequestBudget(controls);
  const configuration = evaluationModelConfiguration(env);
  const configurationSha256 = evaluationConfigurationFingerprint(configuration);
  const corpus = assertCanonicalGoldCorpus();
  const labels = evaluationCorpusLabelCounts(CASES);
  logger.log(
    `corpus sha256: ${evaluationCorpusFingerprint(CASES)} (${CASES.length} cases; ${labels.positive} positive and ${labels.negative} negative labels; ${selectedCases.length} selected)`,
  );
  logger.log(
    'evaluation scope: direct Responses Luna is non-production transport evidence; this run cannot support production Codex CLI quality claims.',
  );
  const results: CaseResult[] = [];
  let invalidCases = 0;
  let degradedRuns = 0;
  let manualCandidateCount = 0;
  for (const [key, group] of caseGroups(selectedCases)) {
    logger.log(`> ${key} (${group.length} case${group.length === 1 ? '' : 's'})`);
    try {
      const review = await reviewPr(group[0], budget, env, logger);
      logger.log(
        `  ${review.findings.length} normal findings, ${review.manualReviewCount} manual candidates (${review.okPasses}/${review.totalPasses} passes, ${review.okRequired}/${review.requiredPasses} required)`,
      );
      manualCandidateCount += review.manualReviewCount;
      if (review.okPasses > 0 && review.okPasses < review.totalPasses) degradedRuns++;
      if (review.okRequired < review.requiredPasses) {
        invalidCases += group.length;
        for (const evaluationCase of group) {
          logger.log(
            `    INVALID ${evaluationCase.name}: required pass failed; excluded from recall`,
          );
        }
        continue;
      }
      const claimed = new Set(review.findings);
      claimed.clear();
      const claimedManual = new Set(review.manualReviewFindings);
      claimedManual.clear();
      for (const evaluationCase of group) {
        const result = scoreCase(evaluationCase, review.findings, claimed);
        results.push(result);
        const manual = scoreCase(evaluationCase, review.manualReviewFindings, claimedManual);
        const parts: string[] = [];
        if (result.recallTotal) parts.push(`recall ${result.recallHits}/${result.recallTotal}`);
        if (evaluationCase.shouldNotFlag?.length)
          parts.push(`${result.falsePositives === 0 ? 'no' : result.falsePositives} false-pos`);
        logger.log(
          `    ${result.falsePositives === 0 && result.recallHits === result.recallTotal ? 'PASS' : 'CHECK'} ${evaluationCase.name}: ${parts.join(', ')}`,
        );
        for (const missing of result.missing) logger.log(`       missed: /${missing}/`);
        for (const falsePositive of result.falsePos)
          logger.log(`       false positive: /${falsePositive}/`);
        if (review.manualReviewFindings.length > 0) {
          logger.log(
            `       manual-only diagnostic: recall ${manual.recallHits}/${manual.recallTotal}; excluded from normal-surface metrics`,
          );
        }
      }
    } catch (error) {
      invalidCases += group.length;
      logger.log(`  ERROR - ${group.length} case(s) INVALID: ${(error as Error).message}`);
    }
  }
  const summary = summarizeNormalSurface(results, CASES);
  logger.log('summary');
  logger.log(
    `normal-surface recall: ${summary.recallHits}/${summary.recallTotal} real bugs caught`,
  );
  logger.log(
    `normal-surface labelled precision: ${summary.falsePositiveChecks - summary.falsePositives}/${summary.falsePositiveChecks} noise checks passed (${summary.falsePositives} false positives)`,
  );
  logger.log('manual-review candidates are deliberately excluded from these metrics.');
  if (degradedRuns > 0)
    logger.log(`${degradedRuns} PR(s) ran with a DEGRADED pipeline; recall may be understated`);
  if (invalidCases > 0 || results.length === 0) process.exitCode = 1;
  const record = {
    schemaVersion: 1,
    kind: 'orvex-labelled-evaluation',
    createdAt: new Date().toISOString(),
    corpus,
    configuration,
    configurationSha256,
    controls: {
      declaredBudgetUsd: controls.declaredBudgetUsd,
      maxRequests: controls.maxRequests,
      maxCases: Number(env.ORVEX_EVAL_MAX_CASES),
      usedRequests: budget.usedRequests,
      operations: budget.operations,
    },
    selectedCases: selectedCases.map((evaluationCase) => evaluationCase.name),
    normalSurface: {
      recall: { hits: summary.recallHits, total: summary.recallTotal },
      labelledPrecision: {
        passed: summary.falsePositiveChecks - summary.falsePositives,
        total: summary.falsePositiveChecks,
        falsePositives: summary.falsePositives,
      },
    },
    manualReviewSurface: { candidates: manualCandidateCount, includedInMetrics: false },
    invalidCases,
    degradedRuns,
    qualityClaimEligible: false,
    productionQualityClaimEligible: false,
    qualityClaimIneligibility:
      'Luna used direct Responses API rather than the production containerized Codex CLI.',
  };
  fs.mkdirSync(path.dirname(controls.resultFile), { recursive: true });
  fs.writeFileSync(controls.resultFile, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
  logger.log(`provenance record: ${controls.resultFile}`);
  return { results, invalidCases, degradedRuns, manualCandidateCount };
}
