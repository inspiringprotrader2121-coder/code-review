import type { SqliteConnection } from '../connection.js';
import type {
  PrKey,
  PrReviewState,
  PrSettings,
  ReviewRun,
  ReviewRunAttempt,
  ReviewRunAttemptOutcome,
  ReviewRunUsage,
  StoredFinding,
} from '../types.js';
import {
  type ReviewReservationInput,
  type ReviewReservationResult,
  type ReviewRunCompletion,
  type ReviewRunRecordInput,
  type ReviewRunStartInput,
  type ReviewStateBillingPort,
  type ReviewStateLookup,
} from './review-state/contracts.js';
import { SqlitePrReviewStateRepository } from './review-state/pr-review-state.js';
import { SqliteReviewAttemptRepository } from './review-state/provider-attempts.js';
import { SqliteReviewRunLifecycleRepository } from './review-state/review-lifecycle.js';
import { SqliteReviewStatisticsRepository } from './review-state/review-statistics.js';

export type {
  ReviewRunStartInput,
  ReviewStateBillingPort,
  ReviewStateLookup,
} from './review-state/contracts.js';

/**
 * Stable application-facing review-state repository. The facade preserves the
 * existing contract while run ownership, provider accounting, PR projections,
 * and query-only statistics evolve independently.
 */
export class SqliteReviewStateRepository {
  private readonly prState: SqlitePrReviewStateRepository;
  private readonly attempts: SqliteReviewAttemptRepository;
  private readonly lifecycle: SqliteReviewRunLifecycleRepository;
  private readonly statistics: SqliteReviewStatisticsRepository;

  constructor(
    db: SqliteConnection,
    lookup: ReviewStateLookup,
    billing: ReviewStateBillingPort,
    workerId: string,
  ) {
    this.prState = new SqlitePrReviewStateRepository(db, lookup);
    this.attempts = new SqliteReviewAttemptRepository(db, workerId);
    this.lifecycle = new SqliteReviewRunLifecycleRepository(db, billing, this.attempts, workerId);
    this.statistics = new SqliteReviewStatisticsRepository(db);
  }

  getState(key: PrKey): PrReviewState | null {
    return this.prState.getState(key);
  }
  saveState(state: PrReviewState): void {
    this.prState.saveState(state);
  }
  getPrSettings(key: PrKey): PrSettings {
    return this.prState.getPrSettings(key);
  }
  setPrAutoApply(key: PrKey, enabled: boolean): void {
    this.prState.setPrAutoApply(key, enabled);
  }
  acquireFixLock(key: PrKey, holder: string, staleMs?: number): boolean {
    return this.prState.acquireFixLock(key, holder, staleMs);
  }
  releaseFixLock(key: PrKey, holder: string): void {
    this.prState.releaseFixLock(key, holder);
  }
  addSuppression(input: {
    installationId: number;
    owner: string;
    repo: string;
    fingerprint: string;
    ruleId?: string;
    suppressedBy?: string;
  }): void {
    this.prState.addSuppression(input);
  }
  getSuppressedFingerprints(installationId: number, owner: string, repo: string): Set<string> {
    return this.prState.getSuppressedFingerprints(installationId, owner, repo);
  }
  projectFindings(
    key: { tenantId: string; installationId: number; owner: string; repo: string; pr: number },
    findings: StoredFinding[],
  ): void {
    this.prState.projectFindings(key, findings);
  }

  countRecentFixRuns(key: PrKey, sinceMs?: number): number {
    return this.statistics.countRecentFixRuns(key, sinceMs);
  }
  countRecentSkippedRuns(key: PrKey, skipReason: string, sinceMs: number): number {
    return this.statistics.countRecentSkippedRuns(key, skipReason, sinceMs);
  }
  countRecentFailedRuns(key: PrKey, sinceMs?: number): number {
    return this.statistics.countRecentFailedRuns(key, sinceMs);
  }
  countGlobalFreeTierReviewsSince(sinceMs: number): number {
    return this.statistics.countGlobalFreeTierReviewsSince(sinceMs);
  }

  recordReviewRun(input: ReviewRunRecordInput): ReviewRun {
    return this.lifecycle.recordReviewRun(input);
  }
  startReviewRun(input: ReviewRunStartInput): string {
    return this.lifecycle.startReviewRun(input);
  }
  tryReserveReviewRun(
    input: ReviewReservationInput,
    limitReason: () => string | null,
  ): ReviewReservationResult {
    return this.lifecycle.tryReserveReviewRun(input, limitReason);
  }
  setReviewRunHeadSha(id: string, headSha: string): boolean {
    return this.lifecycle.setReviewRunHeadSha(id, headSha);
  }
  resumeReviewRun(
    id: string,
    input: Pick<
      ReviewRunStartInput,
      'tenantId' | 'installationId' | 'owner' | 'repo' | 'pr' | 'action'
    >,
  ): 'resumed' | 'completed' | 'unavailable' {
    return this.lifecycle.resumeReviewRun(id, input);
  }
  completeReviewRun(id: string, patch: ReviewRunCompletion): boolean {
    return this.lifecycle.completeReviewRun(id, patch);
  }

  startReviewRunAttempt(
    input: Omit<ReviewRunAttempt, 'outcome' | 'durationMs' | 'completedAt'>,
  ): boolean {
    return this.attempts.startReviewRunAttempt(input);
  }
  completeReviewRunAttempt(input: {
    id: string;
    outcome: Exclude<ReviewRunAttemptOutcome, 'running'>;
    durationMs: number;
    completedAt: string;
    error?: string;
  }): boolean {
    return this.attempts.completeReviewRunAttempt(input);
  }
  listReviewRunAttempts(runId: string): ReviewRunAttempt[] {
    return this.attempts.listReviewRunAttempts(runId);
  }
  recordReviewRunUsage(
    input: Omit<ReviewRunUsage, 'id' | 'createdAt'> & { createdAt?: string },
  ): ReviewRunUsage | null {
    return this.attempts.recordReviewRunUsage(input);
  }
  listReviewRunUsage(runId: string): ReviewRunUsage[] {
    return this.attempts.listReviewRunUsage(runId);
  }
}

export type ReviewStateRepository = Pick<
  SqliteReviewStateRepository,
  | 'getState'
  | 'saveState'
  | 'getPrSettings'
  | 'setPrAutoApply'
  | 'acquireFixLock'
  | 'releaseFixLock'
  | 'addSuppression'
  | 'getSuppressedFingerprints'
  | 'countRecentFixRuns'
  | 'countRecentSkippedRuns'
  | 'countRecentFailedRuns'
  | 'recordReviewRun'
  | 'startReviewRun'
  | 'tryReserveReviewRun'
  | 'countGlobalFreeTierReviewsSince'
  | 'setReviewRunHeadSha'
  | 'resumeReviewRun'
  | 'completeReviewRun'
  | 'startReviewRunAttempt'
  | 'completeReviewRunAttempt'
  | 'listReviewRunAttempts'
  | 'recordReviewRunUsage'
  | 'listReviewRunUsage'
  | 'projectFindings'
>;
