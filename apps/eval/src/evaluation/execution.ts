import {
  REVIEW_INCOMPLETE_SUMMARY,
  RISK_HUNT_FOCUS,
  detectRiskSignals,
  llmFindingsToReviewFindings,
  riskProbeFocus,
  runInvestigateReview,
  runLlmReview,
  selectRiskProbes,
  tagFindingProvenance,
  type ReviewFinding,
} from '@orvex-review/review';
import { checkoutEvalRepo, removeCheckout } from './checkout.js';
import {
  evaluationInvestigateEnabled,
  evaluationInvestigateTarget,
  evaluationMaxRiskProbes,
  evaluationPassTargets,
  evaluationRiskHuntTarget,
} from './configuration.js';
import type { PreparedEvaluationContext } from './context.js';
import type { createBenchmarkOctokit } from '../bench/github-auth.js';
import type { EvalCase } from '../cases.js';
import type { EvaluationRequestBudget } from '../live-controls.js';
import type { EvaluationLogger } from './types.js';

const INVESTIGATE_PASS_FOCUS =
  'INVESTIGATE PASS - P1-FIRST multi-hop search with tools. Prioritize only ' +
  'Critical/High defects this PR introduces or exposes: auth/authz bypass, data ' +
  'loss/corruption, resource leak on failure, asymmetric error paths (success records ' +
  'X but failure skips it), Promise.all/batch partial cleanup, dead checks after refactor, ' +
  'post-transform null/inconsistency, cross-tenant/identity scoping, auth/outage gate ' +
  'bypass, case-insensitive path allowlist drift, pagination past a hard ceiling, and ' +
  'OpenAPI/UI contract drift. Procedure: (1) list symbols this diff deletes ' +
  'or renames and grep their remaining callers; (2) for each changed function, read its ' +
  'full body + immediate callers/callees; (3) compare success vs failure/cleanup paths; ' +
  '(4) kill hypotheses that the code already handles. Report only concrete P1/P2 bugs ' +
  'with file:line and a failure scenario - no style/nits.';

export interface DiscoveryExecution {
  accumulated: ReviewFinding[];
  repeated: Array<{ sample: number; finding: ReviewFinding }>;
  okPasses: number;
  successfulRequiredByLens: Map<number, number>;
}

export async function runDiscoveryPasses(input: {
  prepared: PreparedEvaluationContext;
  env: NodeJS.ProcessEnv;
  budget: EvaluationRequestBudget;
  logger: EvaluationLogger;
  aggregation: { enabled: boolean; effectiveRuns: number; temperature: number };
}): Promise<{
  execution: DiscoveryExecution;
  passes: ReturnType<typeof evaluationPassTargets>;
  samples: number;
  requiredLensIndexes: number[];
}> {
  const passes = evaluationPassTargets(input.env, { files: input.prepared.files });
  const samples = input.aggregation.enabled ? input.aggregation.effectiveRuns : 1;
  const requiredLensIndexes = passes
    .map((pass, index) => (pass.bestEffort ? -1 : index))
    .filter((index) => index >= 0);
  const execution: DiscoveryExecution = {
    accumulated: [],
    repeated: [],
    okPasses: 0,
    successfulRequiredByLens: new Map(),
  };
  const baseContext = { ...(input.prepared.context ?? {}) };
  for (let sample = 0; sample < samples; sample++) {
    for (const [passIndex, pass] of passes.entries()) {
      try {
        input.budget.reserve(`review pass ${pass.tag}`);
        const response = await runLlmReview(input.prepared.reviewFiles, {
          ...pass.target,
          temperature: input.aggregation.enabled ? input.aggregation.temperature : undefined,
          context: pass.focus ? { ...baseContext, extraFocus: pass.focus } : baseContext,
        });
        const findings = llmFindingsToReviewFindings(response.findings);
        for (const finding of findings) tagFindingProvenance(finding, pass.tier, pass.tag);
        const degraded = findings.length === 0 && response.summary === REVIEW_INCOMPLETE_SUMMARY;
        if (!degraded) {
          execution.okPasses++;
          if (!pass.bestEffort) {
            execution.successfulRequiredByLens.set(
              passIndex,
              (execution.successfulRequiredByLens.get(passIndex) ?? 0) + 1,
            );
          }
          if (input.aggregation.enabled)
            execution.repeated.push(...findings.map((finding) => ({ sample, finding })));
        }
        input.logger.log(
          `    pass(${pass.tag}) [${pass.target.model}] sample ${sample + 1}/${samples}: +${findings.length}${degraded ? ' (degraded)' : ''}`,
        );
        if (!input.aggregation.enabled) execution.accumulated.push(...findings);
      } catch (error) {
        input.logger.log(
          `    pass(${pass.tag}) [${pass.target.model}] sample ${sample + 1}/${samples} FAILED: ${(error as Error).message.slice(0, 120)}`,
        );
      }
    }
  }
  return { execution, passes, samples, requiredLensIndexes };
}

export async function runOptionalPasses(input: {
  evaluationCase: EvalCase;
  octokit: Awaited<ReturnType<typeof createBenchmarkOctokit>>;
  prepared: PreparedEvaluationContext;
  env: NodeJS.ProcessEnv;
  budget: EvaluationRequestBudget;
  logger: EvaluationLogger;
}): Promise<{
  investigateFindings: ReviewFinding[];
  riskHuntFindings: ReviewFinding[];
  okPasses: number;
  reservedBonus: number;
}> {
  const investigate = evaluationInvestigateEnabled(input.env)
    ? evaluationInvestigateTarget(input.env)
    : null;
  const riskHunt = input.prepared.highRisk ? evaluationRiskHuntTarget(input.env) : null;
  const probes = riskHunt
    ? selectRiskProbes(
        detectRiskSignals(input.prepared.reviewable),
        evaluationMaxRiskProbes(input.env),
      )
    : [];
  const hunts = !riskHunt
    ? []
    : probes.length > 0
      ? probes.map((signal) => ({ tag: `risk-probe:${signal.id}`, focus: riskProbeFocus(signal) }))
      : [{ tag: 'risk-hunt', focus: RISK_HUNT_FOCUS }];
  let okPasses = 0;
  const investigateFindings: ReviewFinding[] = [];
  if (investigate) {
    const cwd = await checkoutEvalRepo(
      input.octokit,
      input.evaluationCase.owner,
      input.evaluationCase.repo,
      input.prepared.sha,
      input.logger,
    );
    if (cwd) {
      try {
        input.budget.reserve('investigate pass');
        const response = await runInvestigateReview(input.prepared.investigateFiles, {
          cwd,
          ...investigate.target,
          context: { ...(input.prepared.context ?? {}), extraFocus: INVESTIGATE_PASS_FOCUS },
        });
        const findings = llmFindingsToReviewFindings(response.findings);
        for (const finding of findings)
          tagFindingProvenance(finding, investigate.tier, 'investigate');
        const degraded = findings.length === 0 && response.summary === REVIEW_INCOMPLETE_SUMMARY;
        if (!degraded) {
          okPasses++;
          investigateFindings.push(...findings);
        }
        input.logger.log(
          `    pass(investigate) [${investigate.target.model}]: +${findings.length}${degraded ? ' (degraded)' : ''}`,
        );
      } catch (error) {
        input.logger.log(
          `    pass(investigate) [${investigate.target.model}] FAILED: ${(error as Error).message.slice(0, 120)}`,
        );
      } finally {
        removeCheckout(cwd);
      }
    } else {
      input.logger.log('    pass(investigate) skipped: checkout unavailable');
    }
  }
  const riskHuntFindings: ReviewFinding[] = [];
  if (riskHunt) {
    for (const hunt of hunts) {
      try {
        input.budget.reserve(`risk hunt ${hunt.tag}`);
        const response = await runLlmReview(input.prepared.reviewFiles, {
          ...riskHunt.target,
          context: { ...(input.prepared.context ?? {}), extraFocus: hunt.focus },
        });
        const findings = llmFindingsToReviewFindings(response.findings);
        for (const finding of findings) tagFindingProvenance(finding, riskHunt.tier, hunt.tag);
        const degraded = findings.length === 0 && response.summary === REVIEW_INCOMPLETE_SUMMARY;
        if (!degraded) {
          okPasses++;
          riskHuntFindings.push(...findings);
        }
        input.logger.log(
          `    pass(${hunt.tag}) [${riskHunt.target.model}]: +${findings.length}${degraded ? ' (degraded)' : ''}`,
        );
      } catch (error) {
        input.logger.log(
          `    pass(${hunt.tag}) [${riskHunt.target.model}] FAILED: ${(error as Error).message.slice(0, 120)}`,
        );
      }
    }
  }
  return {
    investigateFindings,
    riskHuntFindings,
    okPasses,
    reservedBonus: (investigate ? 1 : 0) + hunts.length,
  };
}
