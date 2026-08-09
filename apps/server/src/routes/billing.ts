import { createHmac, timingSafeEqual } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { createAppDatabase, type AppDatabase, type Tenant } from '@orvex-review/store';
import {
  isPlanId,
  authDisabled,
  legacyAuthMode,
  planFeatures,
  publicPlanLabel,
  TenantService,
  WorkspaceAccessError,
} from '@orvex-review/tenants';
import { checkAuthRateLimit } from './rate-limit.js';
import { sessionUser } from './session.js';
import { escapeHtml, pageShell } from './pages.js';
import { sendOperationalAlert } from '../alerts.js';
import { sameOriginRequest } from './request-security.js';

type PaidPlan = 'review' | 'review-plus' | 'verify-lite' | 'verify';

const CHECKOUT_PLANS: PaidPlan[] = ['review', 'review-plus', 'verify-lite', 'verify'];
function boundedEnvNumber(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : fallback;
}
const CHECKOUT_WINDOW_MS = boundedEnvNumber('ORVEX_CHECKOUT_RATE_WINDOW_MS', 10 * 60_000, 1_000, 24 * 3600_000);
const CHECKOUT_MAX = boundedEnvNumber('ORVEX_CHECKOUT_RATE_MAX', 12, 1, 10_000);
/** Prepaid credit packs (USD cents). Override with ORVEX_CREDIT_PACKS_CENTS=1000,2500,5000,10000 */
const CREDIT_PACKS_CENTS: number[] = (() => {
  const raw = process.env.ORVEX_CREDIT_PACKS_CENTS?.trim();
  if (!raw) return [1000, 2500, 5000, 10_000];
  const parsed = raw
    .split(',')
    .map((p) => Number(p.trim()))
    .filter((n) => Number.isFinite(n) && n >= 100 && n <= 1_000_000)
    .map((n) => Math.floor(n));
  return parsed.length > 0 ? [...new Set(parsed)] : [1000, 2500, 5000, 10_000];
})();
function isCreditPackCents(n: number): boolean {
  return CREDIT_PACKS_CENTS.includes(Math.floor(n));
}
const OVERAGE_EVENT_NAMES: Partial<Record<PaidPlan, string>> = {
  review: 'orvex_review_overage',
  'verify-lite': 'orvex_verify_lite_overage',
  verify: 'orvex_verify_overage',
};

export function billingRoutes(db: AppDatabase = createAppDatabase()) {
  const app = new Hono();
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
    if (!authDisabled() && !legacyAuthMode(db.hasPasswordUsers()) && !sameOriginRequest(c)) {
      return c.json({ error: 'same-origin request required' }, 403);
    }
    if (ws.role !== 'owner') return c.json({ error: 'only a workspace owner can manage billing' }, 403);

    const limit = checkAuthRateLimit(db, `checkout:${clientIp(c)}:${ws.tenant.id}`, {
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
      const url = await createCheckoutUrl(db, ws.tenant, plan, scopedIdempotencyKey(c, ws.tenant, plan));
      return c.json({ url });
    } catch (err) {
      const e = err as CheckoutError;
      return c.json({ error: e.message }, e.status ?? 502);
    }
  });

  /** Prepaid overage top-up — one-time Stripe Payment Checkout that credits the wallet. */
  app.post('/api/workspaces/:slug/billing/credits', async (c) => {
    const ws = workspace(c);
    if (ws instanceof Response) return ws;
    if (!authDisabled() && !legacyAuthMode(db.hasPasswordUsers()) && !sameOriginRequest(c)) {
      return c.json({ error: 'same-origin request required' }, 403);
    }
    if (ws.role !== 'owner') return c.json({ error: 'only a workspace owner can buy credits' }, 403);

    const planId = db.getTenantPlan(ws.tenant.id) ?? 'free';
    const features = planFeatures(planId);
    if (features.overageCentsPerReview === null) {
      return c.json(
        {
          error:
            'Prepaid credits are only available on plans with prepaid overage (Starter, Verify Lite, Verify).',
        },
        400,
      );
    }

    const limit = checkAuthRateLimit(db, `credits:${clientIp(c)}:${ws.tenant.id}`, {
      windowMs: CHECKOUT_WINDOW_MS,
      max: CHECKOUT_MAX,
    });
    if (!limit.allowed) {
      c.header('Retry-After', String(Math.max(limit.retryAfterSeconds, 1)));
      return c.json({ error: 'Too many checkout attempts. Try again in a few minutes.' }, 429);
    }

    const body: { amountCents?: number } = await c.req.json().catch(() => ({}));
    const amountCents = Number(body.amountCents);
    if (!isCreditPackCents(amountCents)) {
      return c.json(
        { error: `amountCents must be one of: ${CREDIT_PACKS_CENTS.join(', ')}` },
        400,
      );
    }

    try {
      const url = await createCreditTopUpUrl(db, ws.tenant, amountCents);
      return c.json({ url, amountCents, balanceCents: db.getCreditBalanceCents(ws.tenant.id) });
    } catch (err) {
      const e = err as CheckoutError;
      return c.json({ error: e.message }, e.status ?? 502);
    }
  });

  app.get('/api/workspaces/:slug/billing/credits', async (c) => {
    const ws = workspace(c);
    if (ws instanceof Response) return ws;
    const features = planFeatures(db.getTenantPlan(ws.tenant.id) ?? 'free');
    return c.json({
      balanceCents: db.getCreditBalanceCents(ws.tenant.id),
      packsCents: features.overageCentsPerReview != null ? CREDIT_PACKS_CENTS : [],
      overageCentsPerReview: features.overageCentsPerReview,
      creditsAvailable: features.overageCentsPerReview != null,
    });
  });

  // Buy from the MARKETING page while signed in: /buy/review | /buy/review-plus
  // | /buy/verify. Sends the user's (owned) workspace straight to Stripe
  // checkout; unauthenticated visitors go to sign-in first. This replaces the
  // in-dashboard plan buttons — the pricing page is the single place to buy.
  app.get('/buy/:plan', async (c) => {
    const plan = c.req.param('plan');
    if (!plan || !isCheckoutPlan(plan)) return c.redirect('/#pricing');

    const limit = checkAuthRateLimit(db, `buy:${clientIp(c)}`, { windowMs: CHECKOUT_WINDOW_MS, max: CHECKOUT_MAX });
    if (!limit.allowed) {
      return c.html(
        pageShell(
          'Checkout unavailable',
          `<h1>Checkout is temporarily paused</h1>
           <p class="lead">Please wait a few minutes and try again.</p>
           <a class="btn" href="/#pricing">Back to plans</a>`,
        ),
        429,
      );
    }

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
      const label = publicPlanLabel(planFeatures(plan));
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
      const url = await createCheckoutUrl(db, selected.tenant, plan, scopedIdempotencyKey(c, selected.tenant, plan));
      return c.redirect(url);
    } catch (err) {
      console.warn('[billing] /buy checkout failed:', (err as Error).message);
      return c.html(
        pageShell(
          'Checkout unavailable',
          `<h1>Checkout could not be started</h1>
           <p class="lead">Your workspace was not charged. Please try again or contact support if the problem continues.</p>
           <a class="btn" href="/#pricing">Back to plans</a>
           <a class="btn secondary" href="mailto:support@useorvex.com">Contact support</a>`,
          user,
        ),
        502,
      );
    }
  });

  app.get('/billing/portal/:slug', async (c) => {
    const ws = workspace(c);
    if (ws instanceof Response) return ws;
    if (ws.role !== 'owner') {
      return c.html(
        pageShell(
          'Billing access',
          `<h1>Only the workspace owner can manage billing</h1>
           <p class="lead">Ask the workspace owner to update payment details or cancel the subscription.</p>
           <a class="btn" href="/dashboard/${encodeURIComponent(ws.tenant.slug)}">Back to dashboard</a>`,
        ),
        403,
      );
    }
    const billing = db.getTenantBilling(ws.tenant.id);
    if (!billing?.stripeCustomerId) {
      return c.redirect(`/dashboard/${encodeURIComponent(ws.tenant.slug)}?billing=unavailable`);
    }
    try {
      const portal = await createBillingPortalUrl(ws.tenant, billing.stripeCustomerId);
      return c.redirect(portal);
    } catch (err) {
      console.warn('[billing] portal session failed:', (err as Error).message);
      return c.redirect(`/dashboard/${encodeURIComponent(ws.tenant.slug)}?billing=portal-error`);
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

    let event: {
      id?: string;
      type?: string;
      created?: number;
      data?: { object?: StripeWebhookObject };
    };
    try {
      event = JSON.parse(rawBody) as typeof event;
    } catch {
      return c.json({ error: 'invalid Stripe event JSON' }, 400);
    }
    if (!event || typeof event !== 'object' || typeof event.type !== 'string' || !event.type) {
      return c.json({ error: 'invalid Stripe event payload' }, 400);
    }
    if (!event.id || typeof event.id !== 'string') {
      return c.json({ error: 'Stripe event missing id' }, 400);
    }
    const eventClaim = db.claimWebhookEvent('stripe', event.id);
    if (!eventClaim) {
      const prior = db.getWebhookEvent('stripe', event.id);
      if (prior?.processedAt) return c.json({ received: true, deduped: true });
      c.header('Retry-After', '5');
      return c.json({ error: 'event is already being processed' }, 503);
    }

    try {
      const object = event.data?.object;
      const tenantId = object?.metadata?.tenant_id;
      const plan = object?.metadata?.plan;

      if (event.type === 'checkout.session.completed') {
      // Prepaid overage top-up (mode=payment) — credit wallet before plan unlock path.
      if (object?.metadata?.purpose === 'credit_topup' && tenantId) {
        const paymentStatus = object?.payment_status;
        if (paymentStatus && paymentStatus !== 'paid' && paymentStatus !== 'no_payment_required') {
          console.warn(
            `[billing] ignoring unpaid credit top-up session for tenant ${tenantId} (payment_status=${paymentStatus})`,
          );
        } else {
          // Prefer Stripe amount_total (what was actually charged) over client metadata.
          const amountTotal = Number(object?.amount_total);
          const metaAmount = Number(object?.metadata?.amount_cents);
          const amountCents =
            Number.isFinite(amountTotal) && amountTotal > 0
              ? amountTotal
              : Number.isFinite(metaAmount) && metaAmount > 0
                ? metaAmount
                : NaN;
          const sessionId = stripeId(object?.id);
          const customerId = stripeId(object?.customer);
          if (!sessionId || !Number.isFinite(amountCents) || amountCents <= 0) {
            throw new Error('Stripe credit top-up checkout is missing session id or amount');
          }
          if (customerId) {
            db.setTenantBilling(tenantId, { stripeCustomerId: customerId });
          }
          const credited = db.creditPrepaidTopUp({
            tenantId,
            amountCents: Math.floor(amountCents),
            stripeSessionId: sessionId,
            note: `prepaid overage top-up $${(amountCents / 100).toFixed(2)}`,
          });
          console.log(
            `[billing] credit top-up tenant=${tenantId} session=${sessionId} applied=${credited.applied} balance_cents=${credited.balanceCents}`,
          );
        }
      } else if (tenantId && plan && isPlanId(plan) && plan !== 'free') {
        const newSub = stripeId(object?.subscription);
        const newCustomer = stripeId(object?.customer);
        if (!newSub || !newCustomer) {
          throw new Error('Stripe checkout.session.completed is missing subscription or customer');
        }
        // Do not unlock paid features on unpaid/incomplete Checkout sessions.
        // Async payment methods can emit completed before funds clear; inventing
        // status='active' bypasses getTenantPlan's dunning downgrade.
        const paymentStatus = object?.payment_status;
        if (paymentStatus && paymentStatus !== 'paid' && paymentStatus !== 'no_payment_required') {
          console.warn(
            `[billing] ignoring checkout.session.completed for unpaid session (payment_status=${paymentStatus}) tenant=${tenantId}`,
          );
        } else {
        // Prevent DOUBLE-BILLING: if this tenant already had a DIFFERENT active
        // subscription (a second tab, a back-button resubmit, or an upgrade via a
        // fresh Checkout), cancel the prior one so at most ONE subscription bills.
        // Cancel BEFORE repointing so a failure here doesn't orphan the old sub id.
        const prior = db.getTenantBilling(tenantId);
        if (prior?.stripeSubscriptionId && newSub && prior.stripeSubscriptionId !== newSub) {
          try {
            await cancelStripeSubscription(prior.stripeSubscriptionId);
          } catch (err) {
            // Do not repoint the tenant while the old subscription may still be
            // active. Throw so Stripe retries the event after the cancellation
            // endpoint recovers instead of creating a double-billing state.
            console.error(
              `[billing] could not cancel superseded subscription ${prior.stripeSubscriptionId} for tenant ${tenantId}:`,
              (err as Error).message,
            );
            throw err;
          }
        }
        // Prefer the subscription's real status + billing period over inventing
        // 'active' from the Checkout Session (session.created is not period start).
        let subscriptionStatus = object?.status;
        let periodStart = stripeTimestampToIso(object?.current_period_start);
        let periodEnd = stripeTimestampToIso(object?.current_period_end);
        try {
          const secret = process.env.STRIPE_SECRET_KEY;
          if (secret && newSub) {
            const sub = await stripeGet<{
              status?: string;
              current_period_start?: number;
              current_period_end?: number;
            }>(`/v1/subscriptions/${encodeURIComponent(newSub)}`, secret);
            subscriptionStatus = sub.status ?? subscriptionStatus;
            periodStart = stripeTimestampToIso(sub.current_period_start) ?? periodStart;
            periodEnd = stripeTimestampToIso(sub.current_period_end) ?? periodEnd;
          }
        } catch (err) {
          console.warn(
            `[billing] could not retrieve subscription ${newSub} on checkout complete:`,
            (err as Error).message,
          );
        }
        const unlocked =
          !subscriptionStatus
          || subscriptionStatus === 'active'
          || subscriptionStatus === 'trialing';
        if (!unlocked) {
          console.warn(
            `[billing] checkout complete but subscription status=${subscriptionStatus} — recording billing without plan unlock`,
          );
          db.setTenantBilling(tenantId, {
            stripeCustomerId: newCustomer,
            stripeSubscriptionId: newSub,
            stripeSubscriptionStatus: subscriptionStatus,
            stripeCurrentPeriodStart: periodStart,
            stripeCurrentPeriodEnd: periodEnd,
          });
        } else {
          db.setTenantPlan(tenantId, plan);
          db.setTenantBilling(tenantId, {
            stripeCustomerId: newCustomer,
            stripeSubscriptionId: newSub,
            stripeSubscriptionStatus: subscriptionStatus ?? 'active',
            stripeCurrentPeriodStart: periodStart ?? stripeTimestampToIso(object?.created) ?? new Date().toISOString(),
            stripeCurrentPeriodEnd: periodEnd,
          });
        }
        db.assignUnlinkedStripeRevenue(newCustomer, tenantId);
        }
      }
      }

      if (event.type === 'customer.subscription.created' || event.type === 'customer.subscription.updated') {
      // SUB-LIFECYCLE GUARD: events for a SUPERSEDED subscription must never
      // repoint billing. A `created` event can arrive before checkout completion,
      // so a tenant that already has a subscription defers the new event until
      // checkout.session.completed atomically retires the old subscription.
      const current = tenantId ? db.getTenantBilling(tenantId) : undefined;
      const createdForDifferentSubscription =
        event.type === 'customer.subscription.created' &&
        Boolean(current?.stripeSubscriptionId) &&
        current?.stripeSubscriptionId !== object?.id;
      if (
        (event.type === 'customer.subscription.updated' || createdForDifferentSubscription) &&
        tenantId &&
        !isCurrentSubscription(db, tenantId, object?.id)
      ) {
        console.warn(
          `[billing] ignoring ${event.type} for superseded/early sub ${object?.id} (tenant ${tenantId})`,
        );
      } else if (tenantId && plan && isPlanId(plan) && plan !== 'free') {
        const subscriptionCustomerId = stripeId(object?.customer);
        db.setTenantPlan(tenantId, plan);
        db.setTenantBilling(tenantId, {
          stripeCustomerId: subscriptionCustomerId,
          stripeSubscriptionId: object?.id,
          stripeSubscriptionStatus: object?.status,
          stripeCurrentPeriodStart: stripeTimestampToIso(object?.current_period_start),
          stripeCurrentPeriodEnd: stripeTimestampToIso(object?.current_period_end),
        });
        if (subscriptionCustomerId) db.assignUnlinkedStripeRevenue(subscriptionCustomerId, tenantId);
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

      if (event.type === 'invoice.paid' || event.type === 'charge.refunded') {
        const customerId = stripeId(object?.customer);
        const revenueTenantId = tenantId ?? (customerId ? db.getTenantByStripeCustomerId(customerId)?.id : undefined);
        const chargeId = event.type === 'charge.refunded' ? object?.id : undefined;
        const cumulativeRefunded = Math.max(0, Number(object?.amount_refunded ?? 0));
        const previouslyRecordedRefunded = chargeId ? db.sumStripeRefundsForCharge(chargeId) : 0;
        const refundDelta = Math.max(0, cumulativeRefunded - previouslyRecordedRefunded);
        const amountCents =
          event.type === 'invoice.paid'
            ? Math.max(0, Number(object?.amount_paid ?? 0))
            : -refundDelta;
        if (event.id && amountCents !== 0) {
          if (!revenueTenantId) {
            console.warn(
              `[billing] recording unlinked ${event.type} ${event.id}; it will be assigned when customer billing is linked`,
            );
          }
          db.recordStripeRevenueEvent({
            eventId: event.id,
            eventType: event.type,
            // For refunds this stores the charge id so a later cumulative
            // charge.refunded webhook can be converted to a delta.
            invoiceId: object?.id,
            tenantId: revenueTenantId,
            customerId,
            subscriptionId: stripeId(object?.subscription),
            amountCents,
            currency: object?.currency ?? 'usd',
            occurredAt:
              (event.type === 'charge.refunded'
                ? stripeTimestampToIso(event.created)
                : stripeTimestampToIso(object?.status_transitions?.paid_at)) ??
              new Date().toISOString(),
          });
        }
        // Claw back unused prepaid wallet credits on charge refunds so a
        // refunded top-up cannot keep funding overage reviews.
        if (event.type === 'charge.refunded' && revenueTenantId && refundDelta > 0 && event.id) {
          const clawed = db.clawbackPrepaidCredits({
            tenantId: revenueTenantId,
            amountCents: refundDelta,
            stripeSessionId: `refund:${event.id}`,
            note: `clawback unused credits for Stripe charge refund ${chargeId ?? ''}`.trim(),
          });
          console.log(
            `[billing] credit clawback tenant=${revenueTenantId} event=${event.id} clawed_cents=${clawed.clawedCents} balance_cents=${clawed.balanceCents}`,
          );
        }
      }

      if (
        event.type === 'charge.dispute.created' ||
        event.type === 'charge.dispute.funds_withdrawn'
      ) {
        const customerId = stripeId(object?.customer);
        const disputeTenantId =
          tenantId ?? (customerId ? db.getTenantByStripeCustomerId(customerId)?.id : undefined);
        const disputeAmount = Math.max(0, Number(object?.amount ?? 0));
        const disputeId = stripeId(object?.id) ?? event.id;
        if (disputeTenantId && disputeAmount > 0 && disputeId) {
          const clawed = db.clawbackPrepaidCredits({
            tenantId: disputeTenantId,
            amountCents: disputeAmount,
            stripeSessionId: `dispute:${disputeId}`,
            note: `clawback unused credits for Stripe dispute ${disputeId}`,
          });
          console.log(
            `[billing] credit dispute clawback tenant=${disputeTenantId} dispute=${disputeId} clawed_cents=${clawed.clawedCents} balance_cents=${clawed.balanceCents}`,
          );
        }
      }

      if (event.id && eventClaim) db.completeWebhookEvent('stripe', event.id, eventClaim);
      return c.json({ received: true });
    } catch (err) {
      if (event.id && eventClaim) db.releaseWebhookEvent('stripe', event.id, eventClaim);
      throw err;
    }
  };

  // Cap the (unauthenticated) webhook body before buffering — Stripe payloads are
  // small; 5MB is generous and blocks a memory-exhaustion POST before verification.
  const stripeBodyLimit = bodyLimit({ maxSize: 5 * 1024 * 1024, onError: (c) => c.json({ error: 'payload too large' }, 413) });
  app.post('/webhooks/stripe', stripeBodyLimit, stripeWebhookHandler);
  app.post('/api/stripe/webhook', stripeBodyLimit, stripeWebhookHandler);

  return app;
}

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
  if (!key) throw new Error('Stripe secret is not configured; cannot cancel superseded subscription');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  let res: Response;
  try {
    res = await fetch(`https://api.stripe.com/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, {
      signal: controller.signal,
      method: 'DELETE',
      headers: { Authorization: `Bearer ${key}` },
    });
  } finally {
    clearTimeout(timer);
  }
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
async function createCheckoutUrl(
  db: AppDatabase,
  tenant: Tenant,
  plan: PaidPlan,
  checkoutIdempotencyKey?: string,
): Promise<string> {
  const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeSecretKey) throw new CheckoutError('Stripe is not configured', 501);

  const basePrice = stripePriceForPlan(plan);
  if (!basePrice) throw new CheckoutError(`missing Stripe price env var for ${plan}`, 501);
  // Overage is prepaid via credit packs — subscription Checkout is base plan only.

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
  const billing = db.getTenantBilling(tenant.id);
  if (billing?.stripeCustomerId) params.customer = billing.stripeCustomerId;

  const session = await stripeRequest<{ url?: string }>(
    '/v1/checkout/sessions',
    stripeSecretKey,
    params,
    checkoutIdempotencyKey,
  );
  if (!session.url) throw new CheckoutError('Stripe did not return a checkout URL', 502);
  return session.url;
}

async function createCreditTopUpUrl(
  db: AppDatabase,
  tenant: Tenant,
  amountCents: number,
): Promise<string> {
  const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeSecretKey) throw new CheckoutError('Stripe is not configured', 501);

  const baseUrl = appBaseUrl();
  const dollars = (amountCents / 100).toFixed(2);
  const params: Record<string, string> = {
    mode: 'payment',
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][product_data][name]': `Orvex prepaid review credits ($${dollars})`,
    'line_items[0][price_data][product_data][description]':
      'Prepaid wallet balance for reviews past your plan included quota. Credits are non-refundable once used.',
    'line_items[0][price_data][unit_amount]': String(amountCents),
    'line_items[0][quantity]': '1',
    success_url: `${baseUrl}/dashboard/${encodeURIComponent(tenant.slug)}?billing=credits-success`,
    cancel_url: `${baseUrl}/dashboard/${encodeURIComponent(tenant.slug)}?billing=credits-cancelled`,
    client_reference_id: tenant.id,
    'metadata[tenant_id]': tenant.id,
    'metadata[tenant_slug]': tenant.slug,
    'metadata[purpose]': 'credit_topup',
    'metadata[amount_cents]': String(amountCents),
  };
  const billing = db.getTenantBilling(tenant.id);
  if (billing?.stripeCustomerId) params.customer = billing.stripeCustomerId;

  const session = await stripeRequest<{ url?: string; id?: string }>(
    '/v1/checkout/sessions',
    stripeSecretKey,
    params,
  );
  if (!session.url) throw new CheckoutError('Stripe did not return a checkout URL', 502);
  return session.url;
}

async function createBillingPortalUrl(tenant: Tenant, customerId: string): Promise<string> {
  const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeSecretKey) throw new CheckoutError('Stripe is not configured', 501);
  const result = await stripeRequest<{ url?: string }>(
    '/v1/billing_portal/sessions',
    stripeSecretKey,
    {
      customer: customerId,
      return_url: `${appBaseUrl()}/dashboard/${encodeURIComponent(tenant.slug)}`,
    },
  );
  if (!result.url) throw new CheckoutError('Stripe did not return a billing portal URL', 502);
  return result.url;
}

function stripePriceForPlan(plan: PaidPlan): string | undefined {
  // 'review-plus' → STRIPE_PRICE_REVIEW_PLUS (env names can't contain hyphens)
  return process.env[`STRIPE_PRICE_${plan.toUpperCase().replace(/-/g, '_')}`];
}

function idempotencyKey(c: Context): string | undefined {
  const value = c.req.header('idempotency-key')?.trim();
  return value ? value.slice(0, 255) : undefined;
}

/** Stripe keys are account-wide; never let a caller reuse one across tenants. */
function scopedIdempotencyKey(c: Context, tenant: Tenant, plan: PaidPlan): string | undefined {
  const key = idempotencyKey(c);
  return key ? `orvex:${tenant.id}:${plan}:${key}`.slice(0, 255) : undefined;
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  let res: Response;
  try {
    res = await fetch(`https://api.stripe.com${path}`, {
      signal: controller.signal,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      body: new URLSearchParams(params),
    });
  } finally {
    clearTimeout(timer);
  }
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

async function stripeGet<T>(path: string, secretKey: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  let res: Response;
  try {
    res = await fetch(`https://api.stripe.com${path}`, {
      signal: controller.signal,
      method: 'GET',
      headers: { Authorization: `Bearer ${secretKey}` },
    });
  } finally {
    clearTimeout(timer);
  }
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
}): Promise<'reported' | 'included' | 'not_configured' | 'pending'> {
  const features = planFeatures(input.plan);
  if (features.includedReviewsPerMonth === null || features.overageCentsPerReview === null) return 'included';

  const billing = input.store.getTenantBilling(input.tenantId);
  if (!billing?.stripeCustomerId) return 'not_configured';

  const existing = input.store.getStripeMeterEvent(input.runId);
  if (existing?.status === 'reported') return 'reported';

  const periodStart =
    billing.stripeCurrentPeriodStart ?? new Date(Date.now() - 30 * 24 * 3_600_000).toISOString();

  // Allocate the run's units in stable creation order. Computing from the
  // current total lets concurrent completions each observe the same total and
  // over-report the quota boundary.
  const units = input.store.reviewRunOverageUnits(input.tenantId, input.runId, periodStart);
  if (!units) throw new Error(`review run ${input.runId} was not found for overage metering`);
  const included = features.includedReviewsPerMonth;
  const overageUnits = Math.max(0, units.unitsThrough - included) - Math.max(0, units.unitsBefore - included);
  if (overageUnits <= 0) return 'included';

  const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
  const eventName = stripeMeterEventName(input.plan);
  let meter = existing;
  if (!meter) {
    // Create the durable outbox row before checking provider configuration.
    // A completed overage must remain retryable across a missing secret or a
    // temporarily unavailable meter name.
    meter = input.store.enqueueStripeMeterEvent({
      runId: input.runId,
      tenantId: input.tenantId,
      customerId: billing.stripeCustomerId,
      eventName: eventName ?? 'orvex_review_overage',
      plan: input.plan,
      units: overageUnits,
    });
  }
  if (!stripeSecretKey || !eventName) {
    void sendOperationalAlert({
      event: 'stripe-meter-configuration-missing',
      severity: 'critical',
      message: `Stripe overage metering is not configured for plan ${input.plan}; event ${input.runId} is pending.`,
    });
    input.store.markStripeMeterAttempt(
      input.runId,
      'Stripe meter configuration is missing',
      new Date(Date.now() + 15 * 60_000).toISOString(),
    );
    return 'pending';
  }
  if (meter.eventName !== eventName) {
    input.store.setStripeMeterEventName(input.runId, eventName);
    meter = input.store.getStripeMeterEvent(input.runId);
  }
  if (!meter) return 'pending';
  return sendStripeMeterEvent(input.store, meter, stripeSecretKey);
}

/** Retry durable overage events after transient Stripe/configuration failures. */
export async function retryStripeMeterEvents(store: AppDatabase, limit = 50): Promise<number> {
  const secret = process.env.STRIPE_SECRET_KEY;
  let reported = 0;
  for (const event of store.listPendingStripeMeterEvents(limit)) {
    const eventName = stripeMeterEventName(event.plan);
    if (!secret || !eventName) {
      void sendOperationalAlert({
        event: 'stripe-meter-configuration-missing',
        severity: 'critical',
        message: `Stripe overage retry cannot report event ${event.runId}; configuration is missing.`,
      });
      store.markStripeMeterAttempt(
        event.runId,
        'Stripe meter configuration is missing',
        new Date(Date.now() + 15 * 60_000).toISOString(),
      );
      continue;
    }
    if (event.eventName !== eventName) {
      store.setStripeMeterEventName(event.runId, eventName);
      event.eventName = eventName;
    }
    try {
      await sendStripeMeterEvent(store, event, secret);
      reported++;
    } catch (err) {
      void sendOperationalAlert({
        event: 'stripe-meter-delivery-failed',
        severity: 'warning',
        message: `Stripe meter retry failed for run ${event.runId}: ${(err as Error).message}`,
      });
      console.error(`[billing] retrying meter event ${event.runId} failed:`, (err as Error).message);
    }
  }
  return reported;
}

function stripeMeterEventName(plan: string): string | undefined {
  const configured = process.env[`STRIPE_METER_EVENT_${plan.toUpperCase().replace(/-/g, '_')}`]?.trim();
  return configured || OVERAGE_EVENT_NAMES[plan as PaidPlan];
}

async function sendStripeMeterEvent(
  store: AppDatabase,
  event: {
    runId: string;
    tenantId: string;
    customerId: string;
    eventName: string;
    plan: string;
    units: number;
  },
  secret: string,
): Promise<'reported' | 'pending'> {
  try {
    await stripeRequest(
      '/v1/billing/meter_events',
      secret,
      {
        event_name: event.eventName,
        identifier: `review_run_${event.runId}`,
        'payload[stripe_customer_id]': event.customerId,
        'payload[value]': String(event.units),
        'payload[tenant_id]': event.tenantId,
        'payload[plan]': event.plan,
      },
      `review_run_${event.runId}`,
    );
    store.markStripeMeterReported(event.runId);
    return 'reported';
  } catch (err) {
    void sendOperationalAlert({
      event: 'stripe-meter-delivery-failed',
      severity: 'warning',
      message: `Stripe meter delivery failed for run ${event.runId}: ${(err as Error).message}`,
    });
    store.markStripeMeterAttempt(
      event.runId,
      (err as Error).message,
      new Date(Date.now() + 60_000).toISOString(),
    );
    throw err;
  }
}

type StripeWebhookObject = {
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
  /** Checkout Session total charged (preferred for credit top-ups). */
  amount_total?: number;
  /** Dispute amount (cents). */
  amount?: number;
  currency?: string;
  status_transitions?: { paid_at?: number };
};

function stripeId(value: string | { id?: string } | undefined): string | undefined {
  return typeof value === 'string' ? value : value?.id;
}

function stripeTimestampToIso(value: number | undefined): string | undefined {
  return typeof value === 'number' ? new Date(value * 1000).toISOString() : undefined;
}

export function verifyStripeSignature(rawBody: string, signature: string | undefined, secret: string): boolean {
  if (!signature || !secret) return false;
  let timestamp: string | undefined;
  const expected: string[] = [];
  for (const part of signature.split(',')) {
    const [key, value] = part.trim().split('=', 2);
    if (key === 't' && value) timestamp = value;
    if (key === 'v1' && value) expected.push(value);
  }
  if (!timestamp || expected.length === 0) return false;

  // Reject stale signatures — without a timestamp-tolerance check a captured,
  // validly-signed event (e.g. subscription.deleted) can be replayed forever to
  // force a paying tenant back to `free`. 5-minute window matches Stripe's SDK.
  const configuredTolerance = Number(process.env.STRIPE_WEBHOOK_TOLERANCE_S ?? 300);
  const toleranceS =
    Number.isFinite(configuredTolerance) && configuredTolerance >= 0
      ? Math.min(Math.floor(configuredTolerance), 3_600)
      : 300;
  const t = Number(timestamp);
  if (!Number.isFinite(t) || Math.abs(Date.now() / 1000 - t) > toleranceS) return false;

  const signedPayload = `${timestamp}.${rawBody}`;
  const digest = createHmac('sha256', secret).update(signedPayload).digest('hex');
  const a = Buffer.from(digest);
  return expected.some((candidate) => {
    const b = Buffer.from(candidate);
    return a.length === b.length && timingSafeEqual(a, b);
  });
}
