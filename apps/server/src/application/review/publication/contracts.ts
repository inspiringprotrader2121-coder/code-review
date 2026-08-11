import type { ReviewJobPayload } from '@orvex-review/queue';
import type { createInstallationOctokit } from '@orvex-review/github';
import type {
  PrReviewState,
  ReviewPublicationRepository,
  ReviewPublicationScope,
  StoredFinding,
} from '@orvex-review/store';
import type { ReviewFinding } from '@orvex-review/review';
import type { PlanFeatures } from '@orvex-review/tenants';
import type { WorkerConfig } from '../../../review/worker-types.js';
import type { TierUsage, UsageCostPolicy } from '../../../review/usage-accounting.js';
import type { FindingPipelineResult } from '../finding-pipeline.js';
import type { ProcessResult } from '../types.js';

export type PublicationWriter<T> = () => Promise<T>;

export interface PublicationPolicy {
  requestChangesOnP1: boolean;
  maxUnanchoredComments: number;
  failCheckOnP1: boolean;
}

export const DEFAULT_PUBLICATION_POLICY: PublicationPolicy = {
  requestChangesOnP1: false,
  maxUnanchoredComments: 3,
  failCheckOnP1: false,
};

export interface PublicationInput {
  job: ReviewJobPayload;
  config: WorkerConfig;
  runId?: string;
  octokit: ReturnType<typeof createInstallationOctokit>;
  ref: { owner: string; repo: string; number: number };
  owner: string;
  repo: string;
  number: number;
  installationId: number;
  tenantId: string;
  effectiveSha: string;
  plan: PlanFeatures;
  pr: { baseSha?: string };
  coverage: {
    complete: boolean;
    reviewed: number;
    candidates: number;
    skippedByCap: number;
    truncatedFiles: number;
    omittedPatch: number;
    githubCapHit?: boolean;
  };
  filesForLlm: Array<{ filename: string }>;
  reviewContextFiles: Array<{ path: string; content: string }>;
  priorState?: PrReviewState | null;
  codexThreadId?: string;
  merged: {
    toPost: ReviewFinding[];
    reviewOnly: Array<{ finding: ReviewFinding; reason: string }>;
    stillOpen: StoredFinding[];
  };
  findings: FindingPipelineResult;
  llmSummary?: string;
  skippedLenses: string[];
  /** Persisted with a completed run so the dashboard can distinguish partial output. */
  incompleteReason?: string;
  verificationIncomplete: boolean;
  verificationInconclusiveCount?: number;
  verificationUnavailableReason?: string;
  usage: TierUsage;
  usagePolicy: UsageCostPolicy;
  deepLensesRan: boolean;
  policy: PublicationPolicy;
  signal: AbortSignal;
  ownershipLost: () => boolean;
  cancelForOwnershipLoss: () => void;
}

export interface ArtifactPublisher {
  publishArtifact<T>(
    scope: Omit<ReviewPublicationScope, 'artifactKey'> | undefined,
    artifactKey: string,
    write: PublicationWriter<T>,
  ): Promise<T>;
}

export type PublicationRepository = ReviewPublicationRepository;
export type PublicationResult = ProcessResult;
