import { PlanCatalog, type BillingConfig } from '@orvex-review/billing';
import { PLANS, type PlanId } from '@orvex-review/tenants';

const DEFAULT_CREDIT_PACKS = [1000, 2500, 5000, 10_000] as const;

function boundedNumber(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = Number(raw ?? fallback);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : fallback;
}
function creditPacks(raw: string | undefined): readonly number[] {
  if (!raw?.trim()) return DEFAULT_CREDIT_PACKS;
  const parsed = raw
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isFinite(value) && value >= 100 && value <= 1_000_000)
    .map((value) => Math.floor(value));
  return parsed.length > 0 ? [...new Set(parsed)] : DEFAULT_CREDIT_PACKS;
}

/** Server-only environment parsing; the billing package receives this immutable value. */
export function loadBillingConfig(env: Readonly<NodeJS.ProcessEnv>): BillingConfig {
  const port = env.PORT ?? '8787';
  return Object.freeze({
    appBaseUrl: (env.APP_URL ?? `http://localhost:${port}`).replace(/\/+$/, ''),
    checkoutRateWindowMs: boundedNumber(
      env.ORVEX_CHECKOUT_RATE_WINDOW_MS,
      10 * 60_000,
      1_000,
      24 * 3_600_000,
    ),
    checkoutRateMax: boundedNumber(env.ORVEX_CHECKOUT_RATE_MAX, 12, 1, 10_000),
    creditPacksCents: creditPacks(env.ORVEX_CREDIT_PACKS_CENTS),
    stripe: Object.freeze({
      secretKey: env.STRIPE_SECRET_KEY?.trim() || undefined,
      webhookSecrets: [env.STRIPE_WEBHOOK_SECRET, env.STRIPE_WEBHOOK_SECRET_2]
        .filter((secret): secret is string => Boolean(secret?.trim()))
        .map((secret) => secret.trim()),
      webhookToleranceSeconds: boundedNumber(env.STRIPE_WEBHOOK_TOLERANCE_S, 300, 0, 3_600),
    }),
  });
}

export function loadPlanCatalog(env: Readonly<NodeJS.ProcessEnv>): PlanCatalog {
  const prices = compactPlanValues({
    review: env.STRIPE_PRICE_REVIEW,
    'review-plus': env.STRIPE_PRICE_REVIEW_PLUS,
    'verify-lite': env.STRIPE_PRICE_VERIFY_LITE,
    verify: env.STRIPE_PRICE_VERIFY,
  });
  const meterNames = compactPlanValues({
    review: env.STRIPE_METER_EVENT_REVIEW,
    'verify-lite': env.STRIPE_METER_EVENT_VERIFY_LITE,
    verify: env.STRIPE_METER_EVENT_VERIFY,
  });
  return new PlanCatalog({
    prices,
    meterNames,
    features: (plan) => PLANS[(plan && Object.hasOwn(PLANS, plan) ? plan : 'free') as PlanId],
  });
}

function compactPlanValues<T extends string>(
  values: Readonly<Partial<Record<T, string | undefined>>>,
): Partial<Record<T, string>> {
  const result: Partial<Record<T, string>> = {};
  for (const [plan, raw] of Object.entries(values) as [T, string | undefined][]) {
    const value = raw?.trim();
    if (value) result[plan] = value;
  }
  return result;
}
