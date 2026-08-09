import type { GitHubAppConfig } from '@orvex-review/github';
import type { ReviewJobPayload } from '@orvex-review/queue';
import type { AppDatabase } from '@orvex-review/store';
import type { PlanFeatures } from '@orvex-review/tenants';
import type { UsageEvent } from '../../review/usage-accounting.js';
import type { LlmTarget } from '../../review/worker-types.js';
import type { ServerConfig } from '../../bootstrap/config.js';

export interface FixResult {
  applied: number;
  skipped: number;
  headMoved: boolean;
}

export type AutofixRuntime = Pick<ServerConfig, 'autofix' | 'verificationEnabled'>;

/** The small persistence surface used by interactive PR commands. */
export type AutofixStore = Pick<
  AppDatabase,
  | 'acquireFixLock'
  | 'completeReviewRun'
  | 'countAccountCommandRuns'
  | 'countRecentFixRuns'
  | 'getState'
  | 'getTenantPlan'
  | 'recordReviewRun'
  | 'releaseFixLock'
  | 'saveState'
  | 'tryReserveReviewRun'
>;

export type CommandUsageRecorder = (usage: UsageEvent) => void;

/** Dependencies deliberately injected by the legacy worker facade. */
export interface AutofixDependencies {
  github: GitHubAppConfig;
  store: AutofixStore;
  standardModel: LlmTarget;
  maxFileBytes: number;
  maxFiles: number;
  leaseValid?: () => boolean | Promise<boolean>;
  createUsageRecorder(
    runId: string,
    tenantId: string,
    stage: 'autofix' | 'ask' | 'explain',
  ): CommandUsageRecorder;
  commandLimitReason(
    owner: string,
    plan: PlanFeatures,
    tenantId: string | undefined,
  ): string | null;
}

export type CommandJob = ReviewJobPayload;
