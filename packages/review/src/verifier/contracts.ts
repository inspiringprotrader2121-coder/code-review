import { z } from 'zod';
import type { LlmAttemptEvent } from '../llm-client.js';
import type { ReviewFinding, ReviewSurfaceFinding } from '../finding.js';
import type { ModelRunner, ModelTarget, TextModelRunRequest } from '../providers/types.js';

export interface VerifierOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  api?: 'chat' | 'responses' | 'anthropic';
  reasoningEffort?: string;
  maxTokens?: number;
  signal?: AbortSignal;
  confirmedCount?: number;
  strict?: boolean;
  verifierTier?: string;
  maxFindingsPerBatch?: number;
  maxTotalChars?: number;
  /** Bounded verifier-batch parallelism chosen by the host scheduler. */
  concurrency?: number;
  onUsage?: (usage: {
    inputTokens: number;
    cachedInputTokens?: number;
    cacheWriteTokens?: number;
    outputTokens: number;
    tokenSource?: 'provider' | 'estimate';
    provider?: string;
    model?: string;
    attemptId?: string;
  }) => void;
  onAttempt?: (event: LlmAttemptEvent) => void;
  runner?: ModelRunner<TextModelRunRequest>;
  target?: ModelTarget;
}

const SeveritySchema = z.enum(['P1', 'P2', 'P3', 'info']);

export const VerdictSchema = z.object({
  verdicts: z.array(
    z.object({
      id: z.number().int(),
      verdict: z.enum(['confirmed', 'rejected', 'unverified']),
      reason: z.string().optional(),
      severity: SeveritySchema.optional(),
      severityEvidence: z.string().optional(),
      duplicateOf: z.number().int().optional(),
    }),
  ),
});

export type Verdicts = z.infer<typeof VerdictSchema>;
export type VerificationStatus = 'verified' | 'partial' | 'unavailable' | 'skipped';

export interface VerifiedFindings {
  status: VerificationStatus;
  unavailableReason?: string;
  kept: ReviewFinding[];
  dropped: Array<{ finding: ReviewFinding; reason: string }>;
  duplicates: Array<{ finding: ReviewFinding; of: ReviewFinding }>;
  unverified: ReviewFinding[];
}

export interface VerificationDisposition {
  toPost: ReviewFinding[];
  reviewOnly: ReviewSurfaceFinding[];
  rescued: Array<{ finding: ReviewFinding; reason: string }>;
  refuted: Array<{ finding: ReviewFinding; reason: string }>;
  verificationIncomplete: boolean;
  /** Required-severity findings kept visible despite a completed verifier returning no verdict. */
  unverifiedRequiredCount: number;
  unavailableReason?: string;
}

export interface FixCandidate {
  file: string;
  findingMessage: string;
  originalCode: string;
  fixedCode: string;
}

export type VerificationBatchResult = Omit<VerifiedFindings, 'status' | 'unavailableReason'>;
