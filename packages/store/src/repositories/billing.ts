import type {
  PlatformCost,
  ScorecardRun,
  StripeMeterEvent,
  StripeRevenueEvent,
  SuperadminCostAnalytics,
  TenantBilling,
} from '../types.js';
import type { SqliteConnection } from '../connection.js';
import { SqliteBillingAnalyticsRepository } from './billing/analytics.js';
import { SqliteStripeMeterOutboxRepository } from './billing/meter-outbox.js';
import { SqlitePrepaidWalletRepository } from './billing/prepaid-wallet.js';
import { SqliteReviewUsageRepository } from './billing/review-usage.js';
import { SqliteStripeRevenueRepository } from './billing/stripe-revenue.js';
import { SqliteTenantSubscriptionRepository } from './billing/tenant-subscription.js';
import type { BillingUsageLookup } from './billing/shared.js';

export type { BillingUsageLookup } from './billing/shared.js';

/**
 * Stable application-facing billing repository. Billing is composed from
 * focused SQLite repositories so callers keep one contract while ledger,
 * subscription, usage, revenue, and outbox concerns evolve independently.
 */
export class SqliteBillingRepository {
  private readonly wallet: SqlitePrepaidWalletRepository;
  private readonly subscriptions: SqliteTenantSubscriptionRepository;
  private readonly usage: SqliteReviewUsageRepository;
  private readonly revenue: SqliteStripeRevenueRepository;
  private readonly meterOutbox: SqliteStripeMeterOutboxRepository;
  private readonly analytics: SqliteBillingAnalyticsRepository;

  constructor(db: SqliteConnection, usage: BillingUsageLookup) {
    this.wallet = new SqlitePrepaidWalletRepository(db);
    this.subscriptions = new SqliteTenantSubscriptionRepository(db);
    this.usage = new SqliteReviewUsageRepository(db);
    this.revenue = new SqliteStripeRevenueRepository(db);
    this.meterOutbox = new SqliteStripeMeterOutboxRepository(db);
    this.analytics = new SqliteBillingAnalyticsRepository(db, usage, this.revenue);
  }

  getCreditBalanceCents(tenantId: string): number {
    return this.wallet.getCreditBalanceCents(tenantId);
  }

  creditPrepaidTopUp(input: {
    tenantId: string;
    amountCents: number;
    stripeSessionId: string;
    note?: string;
  }): { applied: boolean; balanceCents: number } {
    return this.wallet.creditPrepaidTopUp(input);
  }

  debitOverageCredits(
    tenantId: string,
    runId: string,
    amountCents: number,
    note?: string,
  ): boolean {
    return this.wallet.debitOverageCredits(tenantId, runId, amountCents, note);
  }

  overageDebitNetCents(runId: string): number {
    return this.wallet.overageDebitNetCents(runId);
  }

  refundOverageCredits(runId: string, note?: string): boolean {
    return this.wallet.refundOverageCredits(runId, note);
  }

  reconcileOverageDebit(runId: string, correctDebitCents: number, note?: string): boolean {
    return this.wallet.reconcileOverageDebit(runId, correctDebitCents, note);
  }

  clawbackPrepaidCredits(input: {
    tenantId: string;
    amountCents: number;
    stripeSessionId: string;
    note?: string;
  }): { applied: boolean; clawedCents: number; balanceCents: number } {
    return this.wallet.clawbackPrepaidCredits(input);
  }

  getTenantPlan(tenantId: string): string | null {
    return this.subscriptions.getTenantPlan(tenantId);
  }

  setTenantPlan(tenantId: string, plan: string): boolean {
    return this.subscriptions.setTenantPlan(tenantId, plan);
  }

  getTenantBilling(tenantId: string): TenantBilling | null {
    return this.subscriptions.getTenantBilling(tenantId);
  }

  setTenantBilling(tenantId: string, patch: TenantBilling): boolean {
    return this.subscriptions.setTenantBilling(tenantId, patch);
  }

  countAccountReviews(owner: string, opts: { sinceMs?: number } = {}): number {
    return this.usage.countAccountReviews(owner, opts);
  }

  countRunningAccountReviews(owner: string, sinceMs?: number): number {
    return this.usage.countRunningAccountReviews(owner, sinceMs);
  }

  countRunningCogsReservations(owner: string, sinceMs?: number): number {
    return this.usage.countRunningCogsReservations(owner, sinceMs);
  }

  countTenantReviewUnits(
    tenantId: string,
    opts: { sinceMs?: number; sinceIso?: string } = {},
  ): number {
    return this.usage.countTenantReviewUnits(tenantId, opts);
  }

  oldestAccountReviewCreatedAt(owner: string, sinceMs: number): string | null {
    return this.usage.oldestAccountReviewCreatedAt(owner, sinceMs);
  }

  countTenantCompletedReviewsSince(tenantId: string, sinceIso: string): number {
    return this.usage.countTenantCompletedReviewsSince(tenantId, sinceIso);
  }

  completedReviewUnitsSince(tenantId: string, sinceIso: string): number {
    return this.usage.completedReviewUnitsSince(tenantId, sinceIso);
  }

  reviewRunOverageUnits(
    tenantId: string,
    runId: string,
    sinceIso: string,
  ): { unitsBefore: number; unitsThrough: number } | null {
    return this.usage.reviewRunOverageUnits(tenantId, runId, sinceIso);
  }

  countAccountCommandRuns(owner: string, sinceMs?: number): number {
    return this.usage.countAccountCommandRuns(owner, sinceMs);
  }

  secondsSinceLastCompletedReview(
    installationId: number,
    owner: string,
    repo: string,
    pr: number,
    headSha: string,
  ): number | null {
    return this.usage.secondsSinceLastCompletedReview(installationId, owner, repo, pr, headSha);
  }

  recordStripeRevenueEvent(
    input: Omit<StripeRevenueEvent, 'createdAt'> & { createdAt?: string },
  ): boolean {
    return this.revenue.recordStripeRevenueEvent(input);
  }

  assignUnlinkedStripeRevenue(customerId: string, tenantId: string): number {
    return this.revenue.assignUnlinkedStripeRevenue(customerId, tenantId);
  }

  sumStripeRefundsForCharge(chargeId: string): number {
    return this.revenue.sumStripeRefundsForCharge(chargeId);
  }

  enqueueStripeMeterEvent(input: {
    runId: string;
    tenantId: string;
    customerId: string;
    eventName: string;
    plan: string;
    units: number;
  }): StripeMeterEvent {
    return this.meterOutbox.enqueueStripeMeterEvent(input);
  }

  getStripeMeterEvent(runId: string): StripeMeterEvent | null {
    return this.meterOutbox.getStripeMeterEvent(runId);
  }

  listPendingStripeMeterEvents(limit?: number): StripeMeterEvent[] {
    return this.meterOutbox.listPendingStripeMeterEvents(limit);
  }

  markStripeMeterAttempt(runId: string, error: string, nextAttemptAt: string): void {
    this.meterOutbox.markStripeMeterAttempt(runId, error, nextAttemptAt);
  }

  setStripeMeterEventName(runId: string, eventName: string): void {
    this.meterOutbox.setStripeMeterEventName(runId, eventName);
  }

  markStripeMeterReported(runId: string): void {
    this.meterOutbox.markStripeMeterReported(runId);
  }

  listPlatformCosts(): PlatformCost[] {
    return this.revenue.listPlatformCosts();
  }

  upsertPlatformCost(input: {
    category: string;
    amountCents: number;
    note?: string;
  }): PlatformCost {
    return this.revenue.upsertPlatformCost(input);
  }

  deletePlatformCost(category: string): boolean {
    return this.revenue.deletePlatformCost(category);
  }

  getSuperadminCostAnalytics(
    sinceIso: string,
    untilIso: string,
    planPricesCents: Record<string, number> = {},
    recentLimit = 100,
  ): SuperadminCostAnalytics {
    return this.analytics.getSuperadminCostAnalytics(
      sinceIso,
      untilIso,
      planPricesCents,
      recentLimit,
    );
  }

  listScorecardRuns(limit = 500): ScorecardRun[] {
    return this.analytics.listScorecardRuns(limit);
  }

  sumAccountCost(owner: string, sinceMs?: number): { costUsd: number; reviews: number } {
    return this.usage.sumAccountCost(owner, sinceMs);
  }
}

export type BillingRepository = Pick<
  SqliteBillingRepository,
  | 'getCreditBalanceCents'
  | 'creditPrepaidTopUp'
  | 'debitOverageCredits'
  | 'overageDebitNetCents'
  | 'refundOverageCredits'
  | 'reconcileOverageDebit'
  | 'clawbackPrepaidCredits'
  | 'getTenantPlan'
  | 'setTenantPlan'
  | 'getTenantBilling'
  | 'setTenantBilling'
  | 'countAccountReviews'
  | 'countRunningAccountReviews'
  | 'countRunningCogsReservations'
  | 'countTenantReviewUnits'
  | 'oldestAccountReviewCreatedAt'
  | 'countTenantCompletedReviewsSince'
  | 'completedReviewUnitsSince'
  | 'reviewRunOverageUnits'
  | 'countAccountCommandRuns'
  | 'secondsSinceLastCompletedReview'
  | 'recordStripeRevenueEvent'
  | 'assignUnlinkedStripeRevenue'
  | 'sumStripeRefundsForCharge'
  | 'enqueueStripeMeterEvent'
  | 'getStripeMeterEvent'
  | 'listPendingStripeMeterEvents'
  | 'markStripeMeterAttempt'
  | 'setStripeMeterEventName'
  | 'markStripeMeterReported'
  | 'listPlatformCosts'
  | 'upsertPlatformCost'
  | 'deletePlatformCost'
  | 'getSuperadminCostAnalytics'
  | 'listScorecardRuns'
  | 'sumAccountCost'
>;
