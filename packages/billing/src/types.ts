import type { Tenant } from '@orvex-review/store';

export type PaidPlan = 'review' | 'review-plus' | 'verify-lite' | 'verify';

export type StripeWebhookObject = {
  id?: string;
  metadata?: Record<string, string | undefined>;
  customer?: string | { id?: string };
  subscription?: string | { id?: string };
  status?: string;
  payment_status?: string;
  current_period_start?: number;
  current_period_end?: number;
  created?: number;
  amount_paid?: number;
  amount_refunded?: number;
  amount_total?: number;
  amount?: number;
  currency?: string;
  status_transitions?: { paid_at?: number };
};

export type StripeWebhookEvent = {
  id?: string;
  type?: string;
  created?: number;
  data?: { object?: StripeWebhookObject };
};

export type BillingWorkspace = Pick<Tenant, 'id' | 'slug' | 'name'>;

export interface BillingClock {
  now(): Date;
}
export interface BillingLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}
export type BillingAlert = (input: {
  event: string;
  severity: 'warning' | 'critical';
  message: string;
}) => Promise<boolean> | boolean;

export interface BillingDependencies {
  readonly http: typeof fetch;
  readonly clock: BillingClock;
  readonly alert: BillingAlert;
  readonly logger: BillingLogger;
}

export class BillingError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 501 | 502 = 502,
  ) {
    super(message);
  }
}
