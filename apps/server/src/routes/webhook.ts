import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { ReviewQueue } from '@orvex-review/queue';
import { verifyWebhookSignature } from '@orvex-review/github';
import { authorizedAdminMutation } from './admin-auth.js';
import { WebhookDeliveryService } from '../application/github/webhook-delivery-service.js';
import { ManualReviewRequestService } from '../application/github/manual-review-request-service.js';
import { TenantPlanService } from '../application/admin/tenant-plan-service.js';
import {
  createGithubWebhookEventService,
  githubWebhookBodyHash,
  type WebhookRouteDependencies,
} from '../application/github/github-webhook-event-service.js';

export { githubWebhookBodyHash };
export type {
  WebhookRepositoryStore,
  WebhookRouteDependencies,
} from '../application/github/github-webhook-event-service.js';

/**
 * HTTP envelope only: bound the body, verify GitHub's signature, translate
 * durable delivery state to HTTP, and delegate event decisions to the
 * application service.
 */
export function webhookRoutes(queue: ReviewQueue, dependencies: WebhookRouteDependencies) {
  const app = new Hono();
  const { db, config } = dependencies;
  const deliveries = new WebhookDeliveryService(
    dependencies.db,
    dependencies.config.webhook.bodyDedupTtlMs,
  );
  const events = createGithubWebhookEventService(queue, dependencies);
  const manualReviews = new ManualReviewRequestService(
    config.reviewApiSecret,
    dependencies.manualReview,
  );
  const tenantPlans = new TenantPlanService(db);

  app.post(
    '/webhooks/github',
    bodyLimit({
      maxSize: 25 * 1024 * 1024,
      onError: (c) => c.json({ error: 'payload too large' }, 413),
    }),
    async (c) => {
      const githubConfig = dependencies.githubConfig;
      if (!githubConfig) return c.json({ error: 'GitHub App is not configured' }, 503);
      const rawBody = await c.req.text();
      const signature = c.req.header('x-hub-signature-256');
      const event = c.req.header('x-github-event');
      if (!verifyWebhookSignature(githubConfig, rawBody, signature)) {
        return c.json({ error: 'invalid signature' }, 401);
      }

      const deliveryId = c.req.header('x-github-delivery');
      if (!deliveryId) return c.json({ error: 'missing X-GitHub-Delivery' }, 400);
      const claimResult = deliveries.claim({
        deliveryId,
        event,
        rawBody,
        bodyHash: githubWebhookBodyHash(event, rawBody),
      });
      if (claimResult.kind === 'completed_delivery') return c.json({ ok: true, deduped: true });
      if (claimResult.kind === 'busy_delivery') {
        c.header('Retry-After', '5');
        return c.json({ error: 'delivery is already being processed' }, 503);
      }
      if (claimResult.kind === 'completed_body')
        return c.json({ ok: true, deduped: true, reason: 'body' });
      if (claimResult.kind === 'busy_body') {
        c.header('Retry-After', '5');
        return c.json({ error: 'payload is already being processed' }, 503);
      }

      const claim = claimResult as Extract<typeof claimResult, { kind: 'claimed' }>;
      let failed = false;
      try {
        const payload = JSON.parse(rawBody) as Record<string, unknown>;
        const result = await events.dispatch(event, payload);
        return result.status === 400 ? c.json(result.body, 400) : c.json(result.body);
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        deliveries.settle(claim, failed, deliveryId);
      }
    },
  );

  app.post('/review', async (c) => {
    const auth = c.req.header('authorization');
    const supplied = auth?.startsWith('Bearer ') ? auth.slice(7) : undefined;
    const body = await c.req
      .json<{
        owner?: string;
        repo?: string;
        pr?: number;
        headSha?: string;
        repoSlug?: string;
        installationId?: number;
        tenantSlug?: string;
      }>()
      .catch(() => null);
    const result = await manualReviews.handle(supplied, body);
    if (result.kind === 'disabled')
      return c.json({ error: 'endpoint disabled: REVIEW_API_SECRET not set' }, 503);
    if (result.kind === 'unauthorized') return c.json({ error: 'unauthorized' }, 401);
    if (result.kind === 'invalid') return c.json({ error: 'owner, repo, pr required' }, 400);
    if (result.kind === 'unavailable')
      return c.json({ error: 'manual review service unavailable' }, 503);
    if (result.kind === 'accepted') return c.json({ ok: true, job: result.job });
    return c.json({ error: 'manual review service unavailable' }, 503);
  });

  // Admin: set a workspace's subscription plan. This is the billing/admin hook
  // that moves a tenant off the default 'review' plan onto 'verify' etc. — until
  // a real billing surface exists it lets plans be set without hand-editing the
  // DB. Guarded by the separate ORVEX_ADMIN_SECRET credential.
  app.post('/admin/tenants/:slug/plan', async (c) => {
    if (!authorizedAdminMutation(c, db, config)) return c.json({ error: 'unauthorized' }, 401);
    const { plan } = await c.req.json<{ plan?: unknown }>().catch(() => ({ plan: undefined }));
    const result = tenantPlans.setPlan(c.req.param('slug'), plan);
    if (result.kind === 'invalid')
      return c.json({ error: 'plan is not a supported Orvex plan' }, 400);
    if (result.kind === 'not_found') return c.json({ error: 'workspace not found' }, 404);
    if (result.kind === 'updated')
      return c.json({ ok: true, slug: result.slug, plan: result.plan });
    return c.json({ error: 'workspace not found' }, 404);
  });

  return app;
}
