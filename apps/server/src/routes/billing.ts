import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { type AppDatabase, type Tenant } from '@orvex-review/store';
import { TenantService, WorkspaceAccessError } from '@orvex-review/tenants';
import {
  type BillingStore,
  verifyStripeSignature as verifySignature,
  type PaidPlan,
  type StripeWebhookEvent,
} from '@orvex-review/billing';
import { createServerBillingApplication } from '../bootstrap/billing-application.js';
import { checkAuthRateLimit } from './rate-limit.js';
import { sessionUser } from './session.js';
import { escapeHtml, pageShell } from './pages.js';
import { requestSecurity, sameOriginRequest } from './request-security.js';
import type { ServerConfig } from '../bootstrap/config.js';

/** HTTP transport for billing. Pricing, Stripe I/O, and durable settlement live in application/billing. */
export interface BillingRouteDependencies {
  db: AppDatabase;
  config: ServerConfig;
}

export function billingRoutes(dependencies: BillingRouteDependencies) {
  const { db, config } = dependencies;
  const app = new Hono();
  const tenants = new TenantService(db);
  const billing = createServerBillingApplication(db, config);
  const security = requestSecurity(config);

  function workspace(c: Context): { tenant: Tenant; role: 'owner' | 'member' } | Response {
    const slug = c.req.param('slug');
    if (!slug) return c.json({ error: 'workspace slug required' }, 400);
    if (legacyAuthMode(db.hasPasswordUsers(), config)) {
      const tenant = db.getTenantBySlug(slug);
      return tenant ? { tenant, role: 'owner' } : c.json({ error: 'workspace not found' }, 404);
    }
    const user = sessionUser(c, db, config);
    if (!user) return c.json({ error: 'not signed in' }, 401);
    try {
      const { tenant } = tenants.getTenantStatusForUser(slug, user.id);
      const membership = db.getMembership(tenant.id, user.id);
      return membership
        ? { tenant, role: membership.role }
        : c.json({ error: 'not a member of this workspace' }, 403);
    } catch (error) {
      if (error instanceof WorkspaceAccessError)
        return c.json({ error: error.message }, error.status);
      throw error;
    }
  }

  function checkoutRateLimit(key: string) {
    return checkAuthRateLimit(db, key, {
      windowMs: billing.config.checkoutRateWindowMs,
      max: billing.config.checkoutRateMax,
    });
  }

  app.post('/api/workspaces/:slug/billing/checkout', async (c) => {
    const ws = workspace(c);
    if (ws instanceof Response) return ws;
    if (
      !config.authDisabled &&
      !legacyAuthMode(db.hasPasswordUsers(), config) &&
      !sameOriginRequest(c, config)
    ) {
      return c.json({ error: 'same-origin request required' }, 403);
    }
    if (ws.role !== 'owner')
      return c.json({ error: 'only a workspace owner can manage billing' }, 403);
    const limit = checkoutRateLimit(`checkout:${security.clientIp(c)}:${ws.tenant.id}`);
    if (!limit.allowed) return tooManyCheckouts(c, limit.retryAfterSeconds);
    const body: { plan?: string } = await c.req.json().catch(() => ({}));
    if (!body.plan || !billing.catalog.isCheckoutPlan(body.plan)) {
      return c.json(
        { error: `plan must be one of: ${billing.catalog.checkoutPlans().join(', ')}` },
        400,
      );
    }
    try {
      return c.json({
        url: await billing.checkout(
          ws.tenant,
          body.plan,
          scopedIdempotencyKey(c, ws.tenant, body.plan),
        ),
      });
    } catch (error) {
      return checkoutError(c, error);
    }
  });

  app.post('/api/workspaces/:slug/billing/credits', async (c) => {
    const ws = workspace(c);
    if (ws instanceof Response) return ws;
    if (
      !config.authDisabled &&
      !legacyAuthMode(db.hasPasswordUsers(), config) &&
      !sameOriginRequest(c, config)
    ) {
      return c.json({ error: 'same-origin request required' }, 403);
    }
    if (ws.role !== 'owner')
      return c.json({ error: 'only a workspace owner can buy credits' }, 403);
    if (!billing.canBuyCredits(ws.tenant.id))
      return c.json({ error: billing.entitlements.unavailableCreditMessage() }, 400);
    const limit = checkoutRateLimit(`credits:${security.clientIp(c)}:${ws.tenant.id}`);
    if (!limit.allowed) return tooManyCheckouts(c, limit.retryAfterSeconds);
    const body: { amountCents?: number } = await c.req.json().catch(() => ({}));
    const amountCents = Number(body.amountCents);
    if (!billing.entitlements.isCreditPack(amountCents)) {
      return c.json(
        { error: `amountCents must be one of: ${billing.config.creditPacksCents.join(', ')}` },
        400,
      );
    }
    try {
      const url = await billing.topUpCredits(ws.tenant, amountCents);
      return c.json({
        url,
        amountCents,
        balanceCents: billing.creditSnapshot(ws.tenant.id).balanceCents,
      });
    } catch (error) {
      return checkoutError(c, error);
    }
  });

  app.get('/api/workspaces/:slug/billing/credits', (c) => {
    const ws = workspace(c);
    return ws instanceof Response ? ws : c.json(billing.creditSnapshot(ws.tenant.id));
  });

  app.get('/buy/:plan', async (c) => {
    const plan = c.req.param('plan');
    if (!plan || !billing.catalog.isCheckoutPlan(plan)) return c.redirect('/#pricing');
    const limit = checkoutRateLimit(`buy:${security.clientIp(c)}`);
    if (!limit.allowed) {
      return c.html(
        pageShell(
          'Checkout unavailable',
          `<h1>Checkout is temporarily paused</h1><p class="lead">Please wait a few minutes and try again.</p><a class="btn" href="/#pricing">Back to plans</a>`,
        ),
        429,
      );
    }
    const user = sessionUser(c, db, config);
    const buyPath = `/buy/${encodeURIComponent(plan)}`;
    if (!user) return c.redirect(`/auth/login?next=${encodeURIComponent(buyPath)}`);
    const owned = db
      .getWorkspacesForUser(user.id)
      .filter((workspace) => workspace.role === 'owner');
    if (owned.length === 0) return c.redirect('/connect');
    const requestedSlug = c.req.query('workspace');
    if (!requestedSlug && owned.length > 1) {
      const choices = owned
        .map(
          ({ tenant }) =>
            `<a class="btn secondary" href="${buyPath}?workspace=${encodeURIComponent(tenant.slug)}">${escapeHtml(tenant.name)} <code>${escapeHtml(tenant.slug)}</code></a>`,
        )
        .join('');
      return c.html(
        pageShell(
          'Choose workspace',
          `<h1>Choose a workspace</h1><p class="lead">${escapeHtml(billing.catalog.features(plan).label)} is billed per workspace. Select the workspace this subscription should cover.</p><div style="display:grid;gap:10px">${choices}</div><p class="muted" style="margin-top:18px"><a href="/#pricing">Back to pricing</a></p>`,
          user,
        ),
      );
    }
    const selected = requestedSlug
      ? owned.find(({ tenant }) => tenant.slug === requestedSlug)
      : owned[0];
    if (!selected) return c.redirect(buyPath);
    try {
      return c.redirect(
        await billing.checkout(
          selected.tenant,
          plan,
          scopedIdempotencyKey(c, selected.tenant, plan),
        ),
      );
    } catch (error) {
      console.warn('[billing] /buy checkout failed:', (error as Error).message);
      return c.html(
        pageShell(
          'Checkout unavailable',
          `<h1>Checkout could not be started</h1><p class="lead">Your workspace was not charged. Please try again or contact support if the problem continues.</p><a class="btn" href="/#pricing">Back to plans</a><a class="btn secondary" href="mailto:support@useorvex.com">Contact support</a>`,
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
          `<h1>Only the workspace owner can manage billing</h1><p class="lead">Ask the workspace owner to update payment details or cancel the subscription.</p><a class="btn" href="/dashboard/${encodeURIComponent(ws.tenant.slug)}">Back to dashboard</a>`,
        ),
        403,
      );
    }
    const customerId = db.getTenantBilling(ws.tenant.id)?.stripeCustomerId;
    if (!customerId)
      return c.redirect(`/dashboard/${encodeURIComponent(ws.tenant.slug)}?billing=unavailable`);
    try {
      return c.redirect(await billing.portal(ws.tenant, customerId));
    } catch (error) {
      console.warn('[billing] portal session failed:', (error as Error).message);
      return c.redirect(`/dashboard/${encodeURIComponent(ws.tenant.slug)}?billing=portal-error`);
    }
  });

  const stripeWebhookHandler = async (c: Context) => {
    if (!billing.webhookConfigured())
      return c.json({ error: 'Stripe webhook is not configured' }, 501);
    const rawBody = await c.req.text();
    if (!billing.verifyWebhookSignature(rawBody, c.req.header('stripe-signature'))) {
      return c.json({ error: 'invalid Stripe signature' }, 400);
    }
    let event: StripeWebhookEvent;
    try {
      event = JSON.parse(rawBody) as StripeWebhookEvent;
    } catch {
      return c.json({ error: 'invalid Stripe event JSON' }, 400);
    }
    if (!event || typeof event !== 'object' || typeof event.type !== 'string' || !event.type) {
      return c.json({ error: 'invalid Stripe event payload' }, 400);
    }
    if (!event.id || typeof event.id !== 'string')
      return c.json({ error: 'Stripe event missing id' }, 400);
    const result = await billing.processWebhook(event);
    if (result === 'deduped') return c.json({ received: true, deduped: true });
    if (result === 'processing') {
      c.header('Retry-After', '5');
      return c.json({ error: 'event is already being processed' }, 503);
    }
    return c.json({ received: true });
  };
  const stripeBodyLimit = bodyLimit({
    maxSize: 5 * 1024 * 1024,
    onError: (c) => c.json({ error: 'payload too large' }, 413),
  });
  app.post('/webhooks/stripe', stripeBodyLimit, stripeWebhookHandler);
  app.post('/api/stripe/webhook', stripeBodyLimit, stripeWebhookHandler);
  return app;
}

function tooManyCheckouts(c: Context, retryAfterSeconds: number): Response {
  c.header('Retry-After', String(Math.max(retryAfterSeconds, 1)));
  return c.json({ error: 'Too many checkout attempts. Try again in a few minutes.' }, 429);
}

function checkoutError(c: Context, error: unknown): Response {
  const candidate = error as { message?: string; status?: number };
  return c.json(
    { error: candidate.message ?? 'Stripe request failed' },
    candidate.status === 400 || candidate.status === 501 ? candidate.status : 502,
  );
}

function scopedIdempotencyKey(c: Context, tenant: Tenant, plan: PaidPlan): string | undefined {
  const key = c.req.header('idempotency-key')?.trim();
  return key ? `orvex:${tenant.id}:${plan}:${key}`.slice(0, 255) : undefined;
}

export function isCurrentSubscription(
  db: BillingStore,
  tenantId: string,
  subscriptionId: string | undefined,
  config: Pick<ServerConfig, 'billing' | 'billingCatalog' | 'alerts'>,
): boolean {
  return createServerBillingApplication(db, config).isCurrentSubscription(tenantId, subscriptionId);
}

export function verifyStripeSignature(
  rawBody: string,
  signature: string | undefined,
  secret: string,
  config: Pick<ServerConfig, 'billing'>,
): boolean {
  return verifySignature(
    rawBody,
    signature,
    secret,
    config.billing.stripe.webhookToleranceSeconds,
    { now: () => new Date() },
  );
}

function legacyAuthMode(hasPasswordUsers: boolean, config: ServerConfig): boolean {
  return (
    !config.requireLogin &&
    !hasPasswordUsers &&
    !config.oauth.github &&
    !config.oauth.google &&
    !config.authDisabled
  );
}
