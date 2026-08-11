import type { ReviewJobPayload } from '@orvex-review/queue';
import type {
  ChangedFile,
  DiffCoverage,
  PrRef,
  PullRequestMeta,
  RepoContext,
  createInstallationOctokit,
} from '@orvex-review/github';
import type { ReviewFinding } from '@orvex-review/review';
import type { ReviewConfig } from '@orvex-review/rules';
import type { PrReviewState, StoredFinding } from '@orvex-review/store';
import type { PlanFeatures } from '@orvex-review/tenants';
import type { WorkerConfig } from '../../review/worker-types.js';
import type { AdmissionService } from './admission-service.js';
import type { FinalizationService } from './finalization-service.js';
import type { ReviewExecutor } from './review-executor.js';
import type { ReviewPreparation } from './review-preparation.js';

export interface ProcessResult {
  findingCount: number;
  newCount: number;
  fixedCount: number;
  reviewId?: number;
  skipReason?: string;
  /** Output was published, but one or more required passes failed the review. */
  incompleteReason?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  /** GitHub accepted the review. Local finalizer failures must not retry it. */
  published?: boolean;
  newFindings?: Array<{ severity: string; file: string; line?: number }>;
  deepLensesRan?: boolean;
}

export interface PreparedReview {
  job: ReviewJobPayload;
  config: WorkerConfig;
  runId: string;
}

export interface PreparedExecutionReview extends PreparedReview {
  ref: PrRef;
  octokit: ReturnType<typeof createInstallationOctokit>;
  pr: PullRequestMeta;
  effectiveSha: string;
  reviewConfig: ReviewConfig;
  priorState: PrReviewState | null;
  files: ChangedFile[];
  coverage: DiffCoverage;
  verifiedOpen: StoredFinding[];
  verifiedFixed: StoredFinding[];
  readErrorFps: Set<string>;
  ruleFindings: ReviewFinding[];
  filesForLlm: ChangedFile[];
  filesForInvestigate: ChangedFile[];
  highRiskDiff: boolean;
  reviewContext?: RepoContext;
  reviewContextFiles: Array<{ path: string; content: string }>;
  repoTreePaths: string[];
  skipResult?: ProcessResult;
}

export interface AdmittedReview extends PreparedReview {
  startedAt: number;
  plan: PlanFeatures;
}

export type AdmissionResult =
  | { kind: 'skipped'; result: ProcessResult }
  | { kind: 'admitted'; review: AdmittedReview };

export interface ReviewPipelineServices {
  admission: Pick<AdmissionService, 'admit'>;
  preparation: Pick<ReviewPreparation, 'prepare'>;
  executor: Pick<ReviewExecutor, 'execute'>;
  finalization: Pick<FinalizationService, 'complete' | 'fail'>;
}
