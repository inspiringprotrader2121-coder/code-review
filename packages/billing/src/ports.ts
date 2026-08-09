import type {
  BillingRepository,
  MaintenanceRepository,
  TenancyRepository,
} from '@orvex-review/store';

/** The only persistence boundary the billing package may use. */
export type BillingStore = Pick<
  BillingRepository,
  | 'getCreditBalanceCents'
  | 'creditPrepaidTopUp'
  | 'debitOverageCredits'
  | 'refundOverageCredits'
  | 'reconcileOverageDebit'
  | 'clawbackPrepaidCredits'
  | 'getTenantPlan'
  | 'setTenantPlan'
  | 'getTenantBilling'
  | 'setTenantBilling'
  | 'reviewRunOverageUnits'
  | 'recordStripeRevenueEvent'
  | 'assignUnlinkedStripeRevenue'
  | 'sumStripeRefundsForCharge'
  | 'enqueueStripeMeterEvent'
  | 'getStripeMeterEvent'
  | 'listPendingStripeMeterEvents'
  | 'markStripeMeterAttempt'
  | 'setStripeMeterEventName'
  | 'markStripeMeterReported'
> &
  Pick<TenancyRepository, 'getTenantByStripeCustomerId'> &
  Pick<
    MaintenanceRepository,
    'claimWebhookEvent' | 'getWebhookEvent' | 'completeWebhookEvent' | 'releaseWebhookEvent'
  >;
