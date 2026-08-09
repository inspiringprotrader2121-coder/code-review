import {
  verifyFindings,
  type ReviewFinding,
  type ReviewSurfaceFinding,
} from '@orvex-review/review';
import type { ProviderAdapterRegistry } from '../../review/provider-registry.js';
import type { LlmTarget, PassTier } from '../../review/worker-types.js';
import type { FindingPipeline } from './finding-pipeline.js';

export interface VerificationOrchestrationResult {
  toPost: ReviewFinding[];
  reviewOnly: ReviewSurfaceFinding[];
  incomplete: boolean;
  unavailableReason?: string;
}

export async function orchestrateVerification(input: {
  candidates: ReviewFinding[];
  toPost: ReviewFinding[];
  reviewOnly: ReviewSurfaceFinding[];
  files: Array<{ path: string; content: string }>;
  enabled: boolean;
  deepVerify: boolean;
  target: LlmTarget;
  tier: PassTier;
  signal: AbortSignal;
  providers: Pick<ProviderAdapterRegistry, 'textRunnerFor'>;
  findings: Pick<FindingPipeline, 'applyVerification'>;
  onUsage: (usage: {
    inputTokens: number;
    outputTokens: number;
    tokenSource?: 'provider' | 'estimate';
    model?: string;
    attemptId?: string;
    provider?: string;
  }) => void;
  onAttempt: (event: import('@orvex-review/review').LlmAttemptEvent) => void;
}): Promise<VerificationOrchestrationResult> {
  if (input.candidates.length === 0 || !input.enabled) {
    return { toPost: input.toPost, reviewOnly: input.reviewOnly, incomplete: false };
  }
  if (input.files.length === 0) {
    const unavailableReason =
      'Verification skipped: no source files available for the precision gate.';
    console.warn(`[worker] ${unavailableReason}`);
    return {
      toPost: input.toPost,
      reviewOnly: input.reviewOnly,
      incomplete: true,
      unavailableReason,
    };
  }

  const mode = input.deepVerify ? 'strict' : 'recall';
  const verified = await verifyFindings(input.candidates, input.files, {
    apiKey: input.target.apiKey,
    model: input.target.model,
    baseUrl: input.target.baseUrl,
    reasoningEffort: input.target.reasoningEffort,
    maxTokens: input.target.maxTokens,
    runner: input.providers.textRunnerFor(input.target),
    target: input.target,
    strict: input.deepVerify,
    verifierTier: input.tier,
    signal: input.signal,
    confirmedCount: input.toPost.length,
    onUsage: input.onUsage,
    onAttempt: input.onAttempt,
  });
  if (verified.status === 'unavailable') {
    console.warn(
      `[worker] verification (${mode}) UNAVAILABLE — findings preserved without precision gate: ${(verified.unavailableReason ?? 'unknown').slice(0, 160)}`,
    );
  } else if (verified.status === 'partial') {
    console.warn(
      `[worker] verification (${mode}) PARTIAL — kept ${verified.kept.length}/${input.candidates.length}, ${verified.unverified.length} unverified after batch failure${verified.unavailableReason ? `: ${verified.unavailableReason.slice(0, 120)}` : ''}`,
    );
  } else {
    console.log(
      `[worker] verification (${mode}) kept ${verified.kept.length}/${input.candidates.length}${verified.dropped.length ? `, routed ${verified.dropped.length} to manual` : ''}${verified.unverified.length ? `, ${verified.unverified.length} unverified` : ''}`,
    );
  }
  if (verified.dropped.length > 0) {
    console.log(
      `[worker] verification (${mode}) routed ${verified.dropped.length}/${input.candidates.length} to manual review: ${verified.dropped.map((d) => `${d.finding.file} (${d.reason.slice(0, 60)})`).join(' | ')}`,
    );
  }
  if (verified.duplicates.length > 0) {
    console.log(
      `[worker] verification merged ${verified.duplicates.length} duplicate finding(s): ${verified.duplicates.map((d) => `${d.finding.file}:${d.finding.line ?? '?'} → dup of :${d.of.line ?? '?'}`).join(', ')}`,
    );
  }
  const disposition = input.findings.applyVerification({
    toPost: input.toPost,
    reviewOnly: input.reviewOnly,
    verified,
    verifierTier: input.tier,
  });
  if (disposition.rescued.length > 0) {
    console.log(
      `[worker] verification: rescued ${disposition.rescued.length} strong-reasoner finding(s) dropped on hedged grounds: ${disposition.rescued.map((d) => `${d.finding.sourceTier} ${d.finding.file}:${d.finding.line}`).join(', ')}`,
    );
  }
  if (disposition.refuted.length > 0) {
    console.log(
      `[worker] verification: ${disposition.refuted.length} strong-reasoner finding(s) factually refuted and routed to manual review: ${disposition.refuted.map((d) => `${d.finding.sourceTier} ${d.finding.file}:${d.finding.line} (${d.reason.slice(0, 60)})`).join(', ')}`,
    );
  }
  return {
    toPost: disposition.toPost,
    reviewOnly: disposition.reviewOnly,
    incomplete: disposition.verificationIncomplete || verified.status === 'unavailable',
    unavailableReason: disposition.unavailableReason ?? verified.unavailableReason,
  };
}
