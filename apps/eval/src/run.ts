/**
 * Controlled-live evaluation CLI and stable public API.
 *
 * The implementation lives under evaluation/ so configuration, immutable input
 * loading, provider execution, production-aligned partitioning, metrics, and
 * provenance remain independently testable. Importing this module is inert.
 */
import { pathToFileURL } from 'node:url';
import { runControlledEvaluation } from './evaluation/orchestrator.js';

export type { CaseResult, EvaluationPass, PassTarget, PrReviewResult } from './evaluation/types.js';
export {
  evaluationConfigurationFingerprint,
  evaluationInvestigateEnabled,
  evaluationInvestigateTarget,
  evaluationMaxRiskProbes,
  evaluationModelConfiguration,
  evaluationPassTargets,
  evaluationRiskHuntTarget,
  evaluationVerifier,
} from './evaluation/configuration.js';
export { scoreCase } from './evaluation/metrics.js';
export { runControlledEvaluation } from './evaluation/orchestrator.js';

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  runControlledEvaluation().then(
    () => process.exit(process.exitCode ?? 0),
    (error: unknown) => {
      console.error(error);
      process.exit(1);
    },
  );
}
