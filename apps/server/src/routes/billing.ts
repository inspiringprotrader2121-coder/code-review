import { createHmac, timingSafeEqual } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { createAppDatabase, type AppDatabase, type Tenant } from '@orvex-review/store';
import { isPlanId, legacyAuthMode, planFeatures, TenantService, WorkspaceAccessError } from '@orvex-review/tenants';
import { checkRateLimit } from './rate-limit.js';
import { sessionUser } from './session.js';
import { escapeHtml, pageShell } from './pages.js';

type PaidPlan = 'review' | 'review-plus' | 'verify-lite' | 'verify';

const CHECKOUT_PLANS: PaidPlan[] = ['review', 'review-plus', 'verify-lite', 'verify'];
const CHECKOUT_WINDOW_MS = Number(process.env.ORVEX_CHECKOUT_RATE_WINDOW_MS ?? 10 * 60_000);
const CHECKOUT_MAX = Number(process.env.ORVEX_CHECKOUT_RATE_MAX ?? 12);
const OVERAGE_EVENT_NAMES: Partial<Record<PaidPlan, string>> = {
  review: 'orvex_review_overage',
  'verify-lite': 'orvex_verify_lite_overage',
  verify: 'orvex_verify_overage',
};

export function billingRoutes() {
  const app = new Hono();
  const db = createAppDatabase();
  const tenants = new TenantService(db);

  function workspace(c: Context): { tenant: Tenant; role: 'owner' | 'member' } | Response {
    const slug = c.req.param('slug');
    if (!slug) return c.json({ error: 'workspace slug required' }, 400);

    if (legacyAuthMode(db.hasPasswordUsers())) {
      const tenant = db.getTenantBySlug(slug);
      if (!tenant) return c.json({ error: 'workspace not found' }, 404);
      return { tenant, role: 'owner' };
    }

    const user = sessionUser(c, db);
    if (!user) return c.json({ error: 'not signed in' }, 401);
    try {
      const { tenant } = tenants.getTenantStatusForUser(slug, user.id);
      const membership = db.getMembership(tenant.id, user.id);
      if (!membership) return c.json({ error: 'not a member of this workspace' }, 403);
      return { tenant, role: membership.role };
    } catch (err) {
      if (err instanceof WorkspaceAccessError) return c.json({ error: err.message }, err.status);
      throw err;
    }
  }

  app.post('/api/workspaces/:slug/billing/checkout', async (c) => {
    const ws = workspace(c);
    if (ws instanceof Response) return ws;
    if (ws.role !== 'owner') return c.json({ error: 'only a workspace owner can manage billing' }, 403);

    const limit = checkRateLimit(`checkout:${clientIp(c)}:${ws.tenant.id}`, {
      windowMs: CHECKOUT_WINDOW_MS,
      max: CHECKOUT_MAX,
    });
    if (!limit.allowed) {
      c.header('Retry-After', String(Math.max(limit.retryAfterSeconds, 1)));
      return c.json({ error: 'Too many checkout attempts. Try again in a few minutes.' }, 429);
    }

    const body: { plan?: string } = await c.req.json().catch(() => ({}));
    const plan = body.plan;
    if (!plan || !isCheckoutPlan(plan)) {
      return c.json({ error: `plan must be one of: ${CHECKOUT_PLANS.join(', ')}` }, 400);
    }

    try {
      const url = await createCheckoutUrl(db, ws.tenant, plan);
      return c.json({ url });
    } catch (err) {
      const e = err as CheckoutError;
      return c.json({ error: e.message }, e.status ?? 502);
    }
  });

  // Buy from the MARKETING page while signed in: /buy/review | /buy/review-plus
  // | /buy/verify. Sends the user's (owned) workspace straight to Stripe
  // checkout; unauthenticated visitors go to sign-in first. This replaces the
  // in-dashboard plan buttons — the pricing page is the single place to buy.
  app.get('/buy/:plan', async (c) => {
    const plan = c.req.param('plan');
    if (!plan || !isCheckoutPlan(plan)) return c.redirect('/#pricing');

    const limit = checkRateLimit(`buy:${clientIp(c)}`, { windowMs: CHECKOUT_WINDOW_MS, max: CHECKOUT_MAX });
    if (!limit.allowed) return c.redirect('/#pricing');

    const user = sessionUser(c, db);
    const buyPath = `/buy/${encodeURIComponent(plan)}`;
    if (!user) return c.redirect(`/auth/login?next=${encodeURIComponent(buyPath)}`);
    const workspaces = db.getWorkspacesForUser(user.id);
    // Only an OWNER may start a subscription for a workspace — don't fall back to
    // a workspace where the user is merely a member (that would let a member bind
    // billing to a workspace they don't own).
    const owned = workspaces.filter((w) => w.role === 'owner');
    if (owned.length === 0) return c.redirect('/connect'); // no OWNED workspace — install the App first

    const requestedSlug = c.req.query('workspace');
    if (!requestedSlug && owned.length > 1) {
      const label = planFeatures(plan).label;
      const choices = owned
        .map(
          ({ tenant }) =>
            `<a class="btn secondary" href="${buyPath}?workspace=${encodeURIComponent(tenant.slug)}">${escapeHtml(tenant.name)} <code>${escapeHtml(tenant.slug)}</code></a>`,
        )
        .join('');
      return c.html(
        pageShell(
          'Choose workspace',
          `<h1>Choose a workspace</h1>
           <p class="lead">${escapeHtml(label)} is billed per workspace. Select the workspace this subscription should cover.</p>
           <div style="display:grid;gap:10px">${choices}</div>
           <p class="muted" style="margin-top:18px"><a href="/#pricing">Back to pricing</a></p>`,
          user,
        ),
      );
    }

    const selected = requestedSlug
      ? owned.find(({ tenant }) => tenant.slug === requestedSlug)
      : owned[0];
    if (!selected) return c.redirect(`${buyPath}`);

    try {
      const url = await createCheckoutUrl(db, selected.tenant, plan);
      return c.redirect(url);
    } catch (err) {
      console.warn('[billing] /buy checkout failed:', (err as Error).message);
      return c.redirect('/#pricing');
    }
  });

  // Stripe delivers to TWO registered endpoints: /webhooks/stripe (primary) and
  // /api/stripe/webhook (the endpoint registered in Stripe as
  // useorvex.com/api/stripe/webhook — previously a 404, silently dropping
  // events). Each Stripe endpoint has its OWN signing secret, so verification
  // accepts either STRIPE_WEBHOOK_SECRET or STRIPE_WEBHOOK_SECRET_2.
  const stripeWebhookHandler = async (c: Context) => {
    const secrets = [process.env.STRIPE_WEBHOOK_SECRET, process.env.STRIPE_WEBHOOK_SECRET_2].filter(
      (s): s is string => Boolean(s),
    );
    if (secrets.length === 0) return c.json({ error: 'Stripe webhook is not configured' }, 501);

    const signature = c.req.header('stripe-signature');
    const rawBody = await c.req.text();
    if (!secrets.some((secret) => verifyStripeSignature(rawBody, signature, secret))) {
      return c.json({ error: 'invalid Stripe signature' }, 400);
    }

    const event = JSON.parse(rawBody) as {
      id?: string;
      type: string;
      data?: { object?: StripeWebhookObject };
    };
    // Idempotency: drop an event id we've already processed, so a redelivery or a
    // (within-tolerance) replay can't double-apply a state change.
    if (event.id) {
      if (seenStripeEvents.has(event.id)) return c.json({ received: true, deduped: true });
      seenStripeEvents.add(event.id);
      if (seenStripeEvents.size > 5000) {
        for (const id of seenStripeEvents) { seenStripeEvents.delete(id); if (seenStripeEvents.size <= 4000) break; }
      }
    }
    const object = event.data?.object;
    const tenantId = object?.metadata?.tenant_id;
    const plan = object?.metadata?.plan;

    if (event.type === 'checkout.session.completed') {
      if (tenantId && plan && isPlanId(plan) && plan !== 'free') {
        const newSub = stripeId(object?.subscription);
        // Prevent DOUBLE-BILLING: if this tenant already had a DIFFERENT active
        // subscription (a second tab, a back-button resubmit, or an upgrade via a
        // fresh Checkout), cancel the prior one so at most ONE subscription bills.
        // Cancel BEFORE repointing so a failure here doesn't orphan the old sub id.
        const prior = db.getTenantBilling(tenantId);
        if (prior?.stripeSubscriptionId && newSub && prior.stripeSubscriptionId !== newSub) {
          await cancelStripeSubscription(prior.stripeSubscriptionId).catch((e) =>
            console.error(
              `[billing] could not cancel superseded subscription ${prior.stripeSubscriptionId} for tenant ${tenantId}:`,
              (e as Error).message,
            ),
          );
        }
        db.setTenantPlan(tenantId, plan);
        db.setTenantBilling(tenantId, {
          stripeCustomerId: stripeId(object?.customer),
          stripeSubscriptionId: newSub,
        });
      }
    }

    if (event.type === 'customer.subscription.created' || event.type === 'customer.subscription.updated') {
      // SUB-LIFECYCLE GUARD: `updated` events for a SUPERSEDED subscription (the
      // old sub canceled during an upgrade, or a duplicate Checkout) must never
      // repoint billing — only the tenant's CURRENT subscription may mutate state.
      // `created` is exempt: it announces the NEW sub (checkout.session.completed
      // has already repointed, or will), never the old one.
      if (event.type === 'customer.subscription.updated' && tenantId && !isCurrentSubscription(db, tenantId, object?.id)) {
        console.warn(
          `[billing] ignoring subscription.updated for superseded sub ${object?.id} (tenant ${tenantId})`,
        );
      } else if (tenantId && plan && isPlanId(plan) && plan !== 'free') {
        db.setTenantPlan(tenantId, plan);
        db.setTenantBilling(tenantId, {
          stripeCustomerId: stripeId(object?.customer),
          stripeSubscriptionId: object?.id,
          stripeSubscriptionStatus: object?.status,
          stripeCurrentPeriodStart: stripeTimestampToIso(object?.current_period_start),
          stripeCurrentPeriodEnd: stripeTimestampToIso(object?.current_period_end),
        });
      }
    }

    if (event.type === 'customer.subscription.deleted' && tenantId) {
      // SUB-LIFECYCLE GUARD: a `deleted` event for the OLD subscription arrives
      // right after every upgrade (we cancel the superseded sub in
      // checkout.session.completed). Acting on it downgraded a just-upgraded
      // PAYING tenant to free. Only the current subscription may downgrade.
      if (!isCurrentSubscription(db, tenantId, object?.id)) {
        console.warn(
          `[billing] ignoring subscription.deleted for superseded sub ${object?.id} (tenant ${tenantId})`,
        );
      } else {
        db.setTenantPlan(tenantId, 'free');
        db.setTenantBilling(tenantId, {
          stripeSubscriptionId: object?.id,
          stripeSubscriptionStatus: object?.status ?? 'canceled',
          stripeCurrentPeriodStart: stripeTimestampToIso(object?.current_period_start),
          stripeCurrentPeriodEnd: stripeTimestampToIso(object?.current_period_end),
        });
      }
    }

    return c.json({ received: true });
  };

  // Cap the (unauthenticated) webhook body before buffering — Stripe payloads are
  // small; 5MB is generous and blocks a memory-exhaustion POST before verification.
  const stripeBodyLimit = bodyLimit({ maxSize: 5 * 1024 * 1024, onError: (c) => c.json({ error: 'payload too large' }, 413) });
  app.post('/webhooks/stripe', stripeBodyLimit, stripeWebhookHandler);
  app.post('/api/stripe/webhook', stripeBodyLimit, stripeWebhookHandler);

  return app;
}

/** Processed Stripe event ids (single-process, bounded) — webhook idempotency. */
const seenStripeEvents = new Set<string>();

function isCheckoutPlan(plan: string): plan is PaidPlan {
  return (CHECKOUT_PLANS as string[]).includes(plan);
}

/**
 * SUB-LIFECYCLE GUARD: is `subId` the tenant's CURRENT Stripe subscription?
 * deleted/updated webhook handlers must only act on the current sub — Stripe
 * delivers `customer.subscription.deleted` for the superseded sub right after
 * every upgrade, and acting on it downgraded a paying tenant to free.
 * When no sub is stored yet (brand-new tenant) we accept: there is nothing to
 * conflict with. A missing event sub id never matches.
 */
export function isCurrentSubscription(db: AppDatabase, tenantId: string, subId: string | undefined): boolean {
  if (!subId) return false;
  const current = db.getTenantBilling(tenantId)?.stripeSubscriptionId;
  return !current || current === subId;
}

/** Cancel a Stripe subscription immediately (idempotent — a 404 means it's
 *  already gone). Used to retire a superseded subscription so a tenant is never
 *  billed for two at once. */
async function cancelStripeSubscription(subscriptionId: string): Promise<void> {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return;
  const res = await fetch(`https://api.stripe.com/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`Stripe cancel ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  }
}

class CheckoutError extends Error {
  constructor(
    message: string,
    public status: 400 | 501 | 502 = 502,
  ) {
    super(message);
  }
}

/** Create a Stripe checkout session for a tenant+plan and return its URL.
 *  Shared by the dashboard API (POST) and the marketing /buy/:plan redirect. */
async function createCheckoutUrl(db: AppDatabase, tenant: Tenant, plan: PaidPlan): Promise<string> {
  const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeSecretKey) throw new CheckoutError('Stripe is not configured', 501);

  const basePrice = stripePriceForPlan(plan);
  if (!basePrice) throw new CheckoutError(`missing Stripe price env var for ${plan}`, 501);
  const overagePrice = stripeOveragePriceForPlan(plan);
  if (planFeatures(plan).overageCentsPerReview !== null && !overagePrice) {
    throw new CheckoutError(`missing Stripe overage price env var for ${plan}`, 501);
  }

  const baseUrl = appBaseUrl();
  const params: Record<string, string> = {
    mode: 'subscription',
    'line_items[0][price]': basePrice,
    'line_items[0][quantity]': '1',
    success_url: `${baseUrl}/dashboard/${encodeURIComponent(tenant.slug)}?billing=success`,
    cancel_url: `${baseUrl}/dashboard/${encodeURIComponent(tenant.slug)}?billing=cancelled`,
    client_reference_id: tenant.id,
    'metadata[tenant_id]': tenant.id,
    'metadata[tenant_slug]': tenant.slug,
    'metadata[plan]': plan,
    'subscription_data[metadata][tenant_id]': tenant.id,
    'subscription_data[metadata][tenant_slug]': tenant.slug,
    'subscription_data[metadata][plan]': plan,
    allow_promotion_codes: 'true',
  };
  if (overagePrice) params['line_items[1][price]'] = overagePrice;
  const billing = db.getTenantBilling(tenant.id);
  if (billing?.stripeCustomerId) params.customer = billing.stripeCustomerId;

  const session = await stripeRequest<{ url?: string }>('/v1/checkout/sessions', stripeSecretKey, params);
  if (!session.url) throw new CheckoutError('Stripe did not return a checkout URL', 502);
  return session.url;
}

function stripePriceForPlan(plan: PaidPlan): string | undefined {
  // 'review-plus' → STRIPE_PRICE_REVIEW_PLUS (env names can't contain hyphens)
  return process.env[`STRIPE_PRICE_${plan.toUpperCase().replace(/-/g, '_')}`];
}

function stripeOveragePriceForPlan(plan: PaidPlan): string | undefined {
  return process.env[`STRIPE_PRICE_${plan.toUpperCase().replace(/-/g, '_')}_OVERAGE`];
}

function appBaseUrl(): string {
  return (process.env.APP_URL ?? `http://localhost:${process.env.PORT ?? 8787}`).replace(/\/+$/, '');
}

/** Best-effort client IP behind the nginx proxy. */
function clientIp(c: Context): string {
  const realIp = c.req.header('x-real-ip');
  if (realIp?.trim()) return realIp.trim();
  const xff = c.req.header('x-forwarded-for');
  if (xff) {
    const parts = xff.split(',').map((p) => p.trim()).filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1]!;
  }
  return 'unknown';
}

async function stripeRequest<T>(path: string, secretKey: string, params: Record<string, string>, idempotencyKey?: string): Promise<T> {
  const res = await fetch(`https://api.stripe.com${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    body: new URLSearchParams(params),
  });
  const json: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = typeof json === 'object' && json !== null && 'error' in json ? json.error : undefined;
    const message =
      typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string'
        ? error.message
        : `Stripe request failed: ${res.status}`;
    throw new Error(message);
  }
  return json as T;
}

export async function reportStripeReviewOverage(input: {
  store: AppDatabase;
  tenantId: string;
  plan: PaidPlan;
  runId: string;
  /** this run is an `@orvex deep` review — bills as 2 units, not 1 */
  deep?: boolean;
}): Promise<'reported' | 'included' | 'not_configured'> {
  const features = planFeatures(input.plan);
  if (features.includedReviewsPerMonth === null || features.overageCentsPerReview === null) return 'included';

  const billing = input.store.getTenantBilling(input.tenantId);
  if (!billing?.stripeCustomerId) return 'not_configured';

  const periodStart =
    billing.stripeCurrentPeriodStart ?? new Date(Date.now() - 30 * 24 * 3_600_000).toISOString();

  // Deep reviews count as 2 units. `completedReviewUnitsSince` includes THIS
  // run (recorded completed before we're called), so compute how many of this
  // run's units land ABOVE the included line — never over-bill the boundary.
  const thisWeight = input.deep ? 2 : 1;
  const unitsWithThis = input.store.completedReviewUnitsSince(input.tenantId, periodStart);
  const unitsBefore = unitsWithThis - thisWeight;
  const included = features.includedReviewsPerMonth;
  const overageUnits = Math.max(0, unitsWithThis - included) - Math.max(0, unitsBefore - included);
  if (overageUnits <= 0) return 'included';

  const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
  const eventName = process.env[`STRIPE_METER_EVENT_${input.plan.toUpperCase().replace(/-/g, '_')}`] ?? OVERAGE_EVENT_NAMES[input.plan];
  if (!stripeSecretKey || !eventName) return 'not_configured';

  await stripeRequest(
    '/v1/billing/meter_events',
    stripeSecretKey,
    {
      event_name: eventName,
      identifier: `review_run_${input.runId}`,
      'payload[stripe_customer_id]': billing.stripeCustomerId,
      'payload[value]': String(overageUnits),
      'payload[tenant_id]': input.tenantId,
      'payload[plan]': input.plan,
    },
    `review_run_${input.runId}`,
  );
  return 'reported';
}

type StripeWebhookObject = {
  id?: string;
  metadata?: Record<string, string | undefined>;
  customer?: string | { id?: string };
  subscription?: string | { id?: string };
  status?: string;
  current_period_start?: number;
  current_period_end?: number;
};

function stripeId(value: string | { id?: string } | undefined): string | undefined {
  return typeof value === 'string' ? value : value?.id;
}

function stripeTimestampToIso(value: number | undefined): string | undefined {
  return typeof value === 'number' ? new Date(value * 1000).toISOString() : undefined;
}

export function verifyStripeSignature(rawBody: string, signature: string | undefined, secret: string): boolean {
  if (!signature || !secret) return false;
  const parts = Object.fromEntries(
    signature.split(',').map((part) => {
      const [key, value] = part.split('=', 2);
      return [key, value];
    }),
  );
  const timestamp = parts.t;
  const expected = parts.v1;
  if (!timestamp || !expected) return false;

  // Reject stale signatures — without a timestamp-tolerance check a captured,
  // validly-signed event (e.g. subscription.deleted) can be replayed forever to
  // force a paying tenant back to `free`. 5-minute window matches Stripe's SDK.
  const toleranceS = Number(process.env.STRIPE_WEBHOOK_TOLERANCE_S ?? 300);
  const t = Number(timestamp);
  if (!Number.isFinite(t) || Math.abs(Date.now() / 1000 - t) > toleranceS) return false;

  const signedPayload = `${timestamp}.${rawBody}`;
  const digest = createHmac('sha256', secret).update(signedPayload).digest('hex');
  const a = Buffer.from(digest);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
