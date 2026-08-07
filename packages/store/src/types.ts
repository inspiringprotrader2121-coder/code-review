export type FindingStatus = 'open' | 'fixed' | 'ignored';

export interface StoredFinding {
  id: string;
  fingerprint: string;
  file: string;
  line?: number;
  severity: string;
  category: string;
  message: string;
  suggestion?: string;
  /** exact source snippet the fix replaces (anchor for safe auto-apply) */
  originalCode?: string;
  /** machine-applicable replacement for originalCode */
  fixedCode?: string;
  confidence: number;
  ruleId: string;
  status: FindingStatus;
  githubCommentId?: number;
  fixedAtSha?: string;
  firstSeenSha: string;
  lastSeenSha: string;
}

export interface PrReviewState {
  installationId: number;
  tenantId: string;
  owner: string;
  repo: string;
  pr: number;
  lastSha: string;
  findings: StoredFinding[];
  lastReviewAt: string;
  lastSummaryCommentId?: number;
  /** Codex CLI session id; one per PR so re-reviews resume the same session. */
  codexThreadId?: string;
  /**
   * Candidates shown in the collapsed "manual review" table rather than posted
   * inline. Persisted ONLY so `@orvex ignore <file>:<line>` can resolve them:
   * they have no inline comment, so the thread-reply form of `ignore` (which
   * matches on githubCommentId) could never reach them, and the pipeline's
   * suppression filter — which does already cover reviewOnly — had no way of
   * ever receiving their fingerprint. The result was unsuppressable noise that
   * reappeared on every push, forever.
   *
   * Deliberately NOT part of `findings`: these are unconfirmed, and must not
   * count toward new/open/fixed stats or the still-open carry-forward.
   */
  manualReview?: StoredFinding[];
}

export interface PrKey {
  installationId: number;
  owner: string;
  repo: string;
  pr: number;
}

export interface Tenant {
  id: string;
  slug: string;
  name: string;
  createdAt: string;
}

export interface TenantBilling {
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  stripeSubscriptionStatus?: string;
  stripeCurrentPeriodStart?: string;
  stripeCurrentPeriodEnd?: string;
}

export interface GitHubInstallation {
  installationId: number;
  tenantId: string;
  accountLogin: string;
  accountType: 'Organization' | 'User' | string;
  repositorySelection: 'all' | 'selected' | string;
  suspendedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface User {
  id: string;
  githubId: number;
  googleId?: string;
  login: string;
  name?: string;
  avatarUrl?: string;
  email?: string;
  isSuperAdmin: boolean;
  createdAt: string;
}

export interface UserSecurity {
  userId: string;
  totpEnabled: boolean;
  totpSecretEncrypted?: string;
  lastTotpEpoch?: number;
  recoveryCodeHashes: string[];
  updatedAt: string;
}

export interface MfaChallenge {
  id: string;
  userId: string;
  next: string;
  expiresAt: string;
  createdAt: string;
}

export interface Session {
  id: string;
  userId: string;
  expiresAt: string;
  createdAt: string;
}

export type WorkspaceRole = 'owner' | 'member';

export interface WorkspaceMember {
  tenantId: string;
  userId: string;
  role: WorkspaceRole;
  createdAt: string;
}

export type ReviewRunStatus = 'running' | 'completed' | 'skipped' | 'failed';

export interface ReviewRun {
  id: string;
  tenantId: string;
  installationId: number;
  owner: string;
  repo: string;
  pr: number;
  headSha: string;
  action: string;
  status: ReviewRunStatus;
  skipReason?: string;
  error?: string;
  durationMs: number;
  findingsNew: number;
  findingsFixed: number;
  findingsOpen: number;
  costUsd: number;
  deep: boolean;
  createdAt: string;
}

export type UsageTokenSource = 'provider' | 'estimate' | 'unknown';

export interface ReviewRunUsage {
  id: string;
  runId: string;
  tenantId: string;
  provider: string;
  model: string;
  tier: string;
  passName?: string;
  inputTokens: number;
  outputTokens: number;
  inputRatePerM: number;
  outputRatePerM: number;
  costUsd: number;
  tokenSource: UsageTokenSource;
  attemptId?: string;
  createdAt: string;
}

export interface StripeRevenueEvent {
  eventId: string;
  eventType: string;
  invoiceId?: string;
  tenantId?: string;
  customerId?: string;
  subscriptionId?: string;
  amountCents: number;
  currency: string;
  occurredAt: string;
  createdAt: string;
}

export interface StripeMeterEvent {
  runId: string;
  tenantId: string;
  customerId: string;
  eventName: string;
  plan: string;
  units: number;
  status: 'pending' | 'reported';
  attempts: number;
  lastError?: string;
  nextAttemptAt?: string;
  reportedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PlatformCost {
  category: string;
  amountCents: number;
  note?: string;
  updatedAt: string;
}

export interface CostModelAggregate {
  provider: string;
  model: string;
  tier: string;
  calls: number;
  runs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface CostTenantAggregate {
  tenantId: string;
  slug: string;
  name: string;
  plan: string;
  subscriptionStatus?: string;
  runs: number;
  completedRuns: number;
  failedRuns: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  actualRevenueUsd: number;
  modeledMonthlyRevenueUsd: number;
}

export interface CostDailyAggregate {
  day: string;
  costUsd: number;
  actualRevenueUsd: number;
  runs: number;
}

export interface CostCurrencyAggregate {
  currency: string;
  amountCents: number;
}

export interface SuperadminCostAnalytics {
  since: string;
  until: string;
  overview: {
    runs: number;
    completedRuns: number;
    failedRuns: number;
    skippedRuns: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    actualRevenueUsd: number;
    modeledMonthlyRevenueUsd: number;
    monthlyFixedCostUsd: number;
    allocatedFixedCostUsd: number;
    legacyCostUsd: number;
    instrumentedRuns: number;
    runsWithCost: number;
    /** Non-USD revenue is reported separately rather than mixed into USD margin. */
    nonUsdRevenue: CostCurrencyAggregate[];
  };
  byModel: CostModelAggregate[];
  byTenant: CostTenantAggregate[];
  daily: CostDailyAggregate[];
  platformCosts: PlatformCost[];
  recentRuns: Array<
    ReviewRun & {
      usage: ReviewRunUsage[];
      actualCostUsd: number;
      legacyCost: boolean;
    }
  >;
}

/** One completed run's row for the deep-vs-normal scorecard. */
export interface ScorecardRun {
  id: string;
  owner: string;
  repo: string;
  pr: number;
  headSha: string;
  deep: boolean;
  durationMs: number;
  costUsd: number;
  createdAt: string;
  /** what this run newly posted (parsed from new_findings_json; [] when absent) */
  newFindings: Array<{ severity: string; file: string; line?: number }>;
}

export interface PrSettings {
  installationId: number;
  owner: string;
  repo: string;
  pr: number;
  /** auto-apply Orvex's ready fixes on every future review of this PR */
  autoApply: boolean;
  updatedAt: string;
}

export interface Repo {
  id: string;
  installationId: number;
  tenantId: string;
  githubRepoId: number;
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch?: string;
  /** whether Orvex actively reviews PRs on this repo */
  enabled: boolean;
  reviewMode: 'normal' | 'strict';
  autoApply: boolean;
  /** auto-review when a PR is opened/reopened (dashboard settings toggle) */
  reviewOnOpen: boolean;
  /** auto-review on each subsequent push to an open PR (dashboard settings toggle) */
  reviewOnPush: boolean;
  addedAt: string;
  updatedAt: string;
}

export type PullRequestState = 'open' | 'closed' | 'merged';

export interface PullRequest {
  id: string;
  tenantId: string;
  installationId: number;
  repoFullName: string;
  number: number;
  title: string;
  author: string;
  state: PullRequestState;
  draft: boolean;
  headSha: string;
  url?: string;
  openFindings: number;
  openedAt?: string;
  closedAt?: string;
  mergedAt?: string;
  lastReviewedAt?: string;
  updatedAt: string;
}

/** A finding row projected out of PrReviewState for dashboard querying. */
export interface FindingRecord {
  id: string;
  tenantId: string;
  installationId: number;
  repoFullName: string;
  prNumber: number;
  fingerprint: string;
  file: string;
  line?: number;
  severity: string;
  category: string;
  message: string;
  status: FindingStatus;
  ruleId: string;
  githubCommentId?: number;
  firstSeenSha: string;
  fixedAtSha?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceSettings {
  tenantId: string;
  defaultReviewMode: 'normal' | 'strict';
  autoApplyDefault: boolean;
  /** Legacy setting retained for database compatibility; it no longer gates review findings. */
  minConfidence: number;
  maxComments: number;
  /** auto-enable newly-added repos for review */
  autoEnableNewRepos: boolean;
  updatedAt: string;
}

export interface WorkspaceStats {
  sinceDays: number;
  runsTotal: number;
  runsCompleted: number;
  runsSkipped: number;
  runsFailed: number;
  findingsNew: number;
  findingsFixed: number;
  /** total LLM spend (USD) over the window — owner cost visibility */
  costUsd: number;
  avgDurationMs: number | null;
}
