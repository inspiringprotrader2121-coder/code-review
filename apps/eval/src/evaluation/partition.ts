import {
  dropSelfNegatingFindings,
  fingerprintFinding,
  formatModelContribution,
  partitionVerifiedFindings,
  summarizeModelContribution,
  verifyFindings,
  type ReviewFinding,
  type ReviewSurfaceFinding,
} from '@orvex-review/review';
import { evaluationVerifier } from './configuration.js';
import { verificationContext, type PreparedEvaluationContext } from './context.js';
import type { EvaluationRequestBudget } from '../live-controls.js';
import type { EvaluationLogger } from './types.js';

export async function partitionEvaluationFindings(input: {
  findings: ReviewFinding[];
  manualCandidates: ReviewSurfaceFinding[];
  contributionSource: ReviewFinding[];
  prepared: PreparedEvaluationContext;
  budget: EvaluationRequestBudget;
  env: NodeJS.ProcessEnv;
  logger: EvaluationLogger;
}): Promise<{ findings: ReviewFinding[]; manualReviewFindings: ReviewFinding[] }> {
  let findings = dropSelfNegatingFindings(input.findings).kept;
  const retainedManual = new Set(
    dropSelfNegatingFindings(input.manualCandidates.map(({ finding }) => finding)).kept.map(
      fingerprintFinding,
    ),
  );
  let manualCandidates = input.manualCandidates.filter(({ finding }) =>
    retainedManual.has(fingerprintFinding(finding)),
  );
  const contextFiles = verificationContext(input.prepared);
  const candidates = [...findings, ...manualCandidates.map(({ finding }) => finding)];
  if (input.env.ORVEX_VERIFY !== '0' && contextFiles.length > 0 && candidates.length > 0) {
    const verifier = evaluationVerifier(input.env);
    input.budget.reserve('verification pass');
    const verified = await verifyFindings(candidates, contextFiles, {
      ...verifier.target,
      strict: true,
      confirmedCount: findings.length,
      verifierTier: verifier.tier,
    });
    const disposition = partitionVerifiedFindings(findings, manualCandidates, verified, {
      verifierTier: verifier.tier,
    });
    if (disposition.rescued.length > 0) {
      input.logger.log(
        `    rescued ${disposition.rescued.length} strong-reasoner finding(s) dropped on hedged grounds`,
      );
    }
    findings = disposition.toPost;
    manualCandidates = disposition.reviewOnly;
  } else if (input.env.ORVEX_VERIFY === '0' && candidates.length > 0) {
    input.logger.log('    verification skipped (ORVEX_VERIFY=0)');
  }
  input.logger.log(
    `    model contribution (pre-dedupe): ${formatModelContribution(summarizeModelContribution(input.contributionSource))}`,
  );
  input.logger.log(
    `    model contribution (posted): ${formatModelContribution(summarizeModelContribution(findings))}`,
  );
  return { findings, manualReviewFindings: manualCandidates.map(({ finding }) => finding) };
}
