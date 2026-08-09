import {
  fitReviewAggregationToBudget,
  readReviewAggregationConfig,
  selectRiskProbes,
  detectRiskSignals,
} from '@orvex-review/review';
import { createBenchmarkOctokit } from '../bench/github-auth.js';
import type { EvalCase } from '../cases.js';
import type { EvaluationRequestBudget } from '../live-controls.js';
import { aggregateEvaluationFindings } from './aggregation.js';
import {
  evaluationInvestigateEnabled,
  evaluationInvestigateTarget,
  evaluationMaxRiskProbes,
  evaluationPassTargets,
  evaluationRiskHuntTarget,
} from './configuration.js';
import { prepareEvaluationContext } from './context.js';
import { runDiscoveryPasses, runOptionalPasses } from './execution.js';
import { partitionEvaluationFindings } from './partition.js';
import type { EvaluationLogger, PrReviewResult } from './types.js';

/** Runs one immutable PR through the same pass, aggregation, and partition policy as production. */
export async function reviewPr(
  evaluationCase: EvalCase,
  budget: EvaluationRequestBudget,
  env: NodeJS.ProcessEnv = process.env,
  logger: EvaluationLogger = { log: (message) => console.log(message) },
): Promise<PrReviewResult> {
  const octokit = await createBenchmarkOctokit(evaluationCase.owner, evaluationCase.repo);
  const prepared = await prepareEvaluationContext(evaluationCase, octokit, env);
  const passes = evaluationPassTargets(env, { files: prepared.files });
  const riskHunt = prepared.highRisk ? evaluationRiskHuntTarget(env) : null;
  const riskHuntCount = riskHunt
    ? (() => {
        const probes = selectRiskProbes(
          detectRiskSignals(prepared.reviewable),
          evaluationMaxRiskProbes(env),
        );
        return probes.length || 1;
      })()
    : 0;
  const investigate = evaluationInvestigateEnabled(env) ? evaluationInvestigateTarget(env) : null;
  const reservedBonus = (investigate ? 1 : 0) + riskHuntCount;
  const requestedAggregation = readReviewAggregationConfig(env);
  const configuredMaxCalls = Number(env.ORVEX_REVIEW_MAX_CALLS ?? 28);
  const maxCalls = Number.isFinite(configuredMaxCalls)
    ? Math.max(1, Math.floor(configuredMaxCalls))
    : 28;
  const aggregation = fitReviewAggregationToBudget(
    requestedAggregation,
    passes.length,
    maxCalls,
    reservedBonus,
  );
  if (requestedAggregation.enabled && !aggregation.enabled) {
    logger.log(`    aggregation disabled: ${aggregation.disabledReason}`);
  }
  const samples = aggregation.enabled ? aggregation.effectiveRuns : 1;
  const requiredPasses = passes.filter((pass) => !pass.bestEffort).length;
  if (prepared.reviewable.length === 0) {
    return {
      findings: [],
      manualReviewCount: 0,
      manualReviewFindings: [],
      okPasses: 0,
      totalPasses: passes.length * samples + reservedBonus,
      requiredPasses,
      okRequired: 0,
    };
  }
  const discovery = await runDiscoveryPasses({ prepared, env, budget, logger, aggregation });
  const optional = await runOptionalPasses({
    evaluationCase,
    octokit,
    prepared,
    env,
    budget,
    logger,
  });
  const okRequired = discovery.requiredLensIndexes.filter(
    (index) => (discovery.execution.successfulRequiredByLens.get(index) ?? 0) >= 1,
  ).length;
  const underSampled =
    aggregation.enabled &&
    discovery.requiredLensIndexes.some(
      (index) =>
        (discovery.execution.successfulRequiredByLens.get(index) ?? 0) < aggregation.minOccurrences,
    );
  if (underSampled) {
    logger.log(
      '    aggregation under-sampled (degraded, still scoring - mirrors production disclosure)',
    );
  }
  const merged = await aggregateEvaluationFindings({
    enabled: aggregation.enabled,
    temperature: aggregation.temperature,
    minOccurrences: aggregation.minOccurrences,
    maxCandidates: aggregation.maxCandidates,
    repeated: discovery.execution.repeated,
    accumulated: discovery.execution.accumulated,
    investigateFindings: optional.investigateFindings,
    riskHuntFindings: optional.riskHuntFindings,
    budget,
    env,
    logger,
  });
  const partitioned = await partitionEvaluationFindings({
    findings: merged.findings,
    manualCandidates: merged.manualCandidates,
    contributionSource: merged.contributionSource,
    prepared,
    budget,
    env,
    logger,
  });
  return {
    findings: partitioned.findings,
    manualReviewCount: partitioned.manualReviewFindings.length,
    manualReviewFindings: partitioned.manualReviewFindings,
    okPasses: discovery.execution.okPasses + optional.okPasses,
    totalPasses: discovery.passes.length * discovery.samples + optional.reservedBonus,
    requiredPasses,
    okRequired,
  };
}
