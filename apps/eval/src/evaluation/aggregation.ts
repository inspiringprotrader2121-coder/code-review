import {
  aggregateRepeatedFindings,
  fingerprintFinding,
  llmChat,
  mergeFindingProvenance,
  type ReviewFinding,
  type ReviewSurfaceFinding,
} from '@orvex-review/review';
import { evaluationVerifier } from './configuration.js';
import type { EvaluationLogger } from './types.js';
import type { EvaluationRequestBudget } from '../live-controls.js';

export function dedupeFindings(candidates: ReviewFinding[]): ReviewFinding[] {
  const byFingerprint = new Map<string, ReviewFinding>();
  const order: string[] = [];
  for (const candidate of candidates) {
    const fingerprint = fingerprintFinding(candidate);
    const existing = byFingerprint.get(fingerprint);
    if (existing) mergeFindingProvenance(existing, candidate);
    else {
      byFingerprint.set(fingerprint, candidate);
      order.push(fingerprint);
    }
  }
  return order.map((fingerprint) => byFingerprint.get(fingerprint)!);
}

export async function aggregateEvaluationFindings(input: {
  enabled: boolean;
  temperature: number;
  minOccurrences: number;
  maxCandidates: number;
  repeated: Array<{ sample: number; finding: ReviewFinding }>;
  accumulated: ReviewFinding[];
  investigateFindings: ReviewFinding[];
  riskHuntFindings: ReviewFinding[];
  budget: EvaluationRequestBudget;
  env: NodeJS.ProcessEnv;
  logger: EvaluationLogger;
}): Promise<{
  findings: ReviewFinding[];
  manualCandidates: ReviewSurfaceFinding[];
  contributionSource: ReviewFinding[];
}> {
  if (!input.enabled) {
    const contributionSource = [
      ...input.accumulated,
      ...input.investigateFindings,
      ...input.riskHuntFindings,
    ];
    return {
      findings: dedupeFindings(contributionSource),
      manualCandidates: [],
      contributionSource,
    };
  }
  const verifier = evaluationVerifier(input.env);
  const merged = await aggregateRepeatedFindings(input.repeated, {
    minOccurrences: input.minOccurrences,
    maxCandidates: input.maxCandidates,
    mergeWithLlm: (system, user) => {
      input.budget.reserve('aggregation merge');
      return llmChat(system, user, {
        ...verifier.target,
        temperature: input.temperature,
        json: true,
      });
    },
  });
  input.logger.log(
    `    aggregation: ${merged.findings.length} recurring, ${merged.reviewOnly.length} manual, ` +
      `${merged.usedLlmMerge ? 'LLM merge' : 'fingerprint fallback'}` +
      (input.investigateFindings.length
        ? `, ${input.investigateFindings.length} investigate`
        : '') +
      (input.riskHuntFindings.length ? `, ${input.riskHuntFindings.length} risk-hunt` : ''),
  );
  return {
    findings: dedupeFindings([
      ...merged.findings,
      ...input.investigateFindings,
      ...input.riskHuntFindings,
    ]),
    manualCandidates: merged.reviewOnly,
    contributionSource: [
      ...input.repeated.map(({ finding }) => finding),
      ...input.investigateFindings,
      ...input.riskHuntFindings,
    ],
  };
}
