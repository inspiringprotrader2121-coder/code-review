import { existsSync } from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import type { DeadLetterRecord, ReviewQueue } from '@orvex-review/queue';
import type {
  BillingRepository,
  IdentityRepository,
  RepositoryWriteRepository,
  ReviewPublicationOperatorRepository,
  TenancyRepository,
} from '@orvex-review/store';
import type { GitHubAppConfig } from '@orvex-review/github';
import { authorizedAdmin, authorizedAdminMutation } from './admin-auth.js';
import { pageShell } from './pages.js';
import { sessionUser } from './session.js';
import { planFeatures, publicPlanLabel } from '@orvex-review/tenants';
import { sampleActiveReviews } from '../active-reviews.js';
import { getQueueDepth } from '../queue-runner.js';
import { renderSuperadminPage } from '../ui/superadmin-view.js';
import type { ServerConfig } from '../bootstrap/config.js';
import {
  SuperadminMetricsService,
  type SuperadminMetricsStore,
} from '../application/admin/superadmin-metrics-service.js';
import { PublicationOperatorService } from '../application/admin/publication-operator-service.js';
import {
  RevenueReconciliationService,
  stripeObjectClient,
} from '../application/admin/revenue-reconciliation-service.js';
import { ScoreboardService } from '../application/admin/scoreboard-service.js';

/**
 * SUPER-ADMIN area — operator-only tooling, completely separate from tenant
 * dashboards. Browser access requires a signed-in user with the database-backed
 * super-admin role. Bearer-secret access remains available for automation.
 *
 * Contents: the competitive scoreboard (ROADMAP Phase 1) — Orvex vs the other
 * review bots on this repo's PRs: catch counts, unique catches, and the
 * miss list (defects others flagged that Orvex didn't → each one is a
 * candidate rule/lens improvement).
 */

export interface SuperadminRouteDependencies {
  db: SuperadminMetricsStore &
    ReviewPublicationOperatorRepository &
    Pick<IdentityRepository, 'getSessionUser' | 'upsertUserFromGitHub'> &
    Pick<TenancyRepository, 'getTenantById' | 'listStripeCustomers'> &
    Pick<RepositoryWriteRepository, 'listScanTargets'> &
    Pick<
      BillingRepository,
      'getTenantPlan' | 'recordStripeRevenueEvent' | 'sumStripeRefundsForCharge'
    >;
  config: ServerConfig;
  githubConfig?: GitHubAppConfig;
  /** Explicit queue port for operator-only dead-letter inspection and replay. */
  queue?: Pick<ReviewQueue, 'listDeadLetters' | 'replayDeadLetter'>;
}

interface DeadLetterView {
  id: string;
  owner: string;
  repository: string;
  pullRequest: number;
  kind: string;
  action: string;
  failureCode: string;
  failedAt: string;
  attempts: number;
}

function deadLetterView(record: DeadLetterRecord): DeadLetterView {
  return {
    id: record.id,
    owner: record.job.owner,
    repository: record.job.repo,
    pullRequest: record.job.pr,
    kind: record.job.kind ?? 'review',
    action: record.job.action,
    failureCode: record.reason,
    failedAt: record.failedAt,
    attempts: record.attempts,
  };
}

export function superadminRoutes(dependencies: SuperadminRouteDependencies) {
  const { db, config } = dependencies;
  const queue = dependencies.queue;
  const app = new Hono();
  const metrics = new SuperadminMetricsService(db);
  const publications = new PublicationOperatorService(db);
  const scoreboards = new ScoreboardService(db, config.databasePath);

  app.get('/superadmin', (c) => {
    const user = sessionUser(c, db, config);
    if (!user) return c.redirect('/auth/login?next=/superadmin');
    if (!user.isSuperAdmin) {
      return c.html(
        pageShell(
          'Access denied',
          '<h1>Access denied</h1><p>This account is not a super administrator.</p>',
          user,
        ),
        403,
      );
    }
    return c.html(renderSuperadminPage());
  });

  /**
   * Live host + per-client-review resource snapshot.
   * One row per FULL in-flight review (not per model pass). Polls from the
   * super-admin UI so operators can watch concurrent client load.
   */
  app.get('/superadmin/api/active-reviews', async (c) => {
    if (!authorizedAdmin(c, db, config)) return c.json({ error: 'unauthorized' }, 401);
    const snap = sampleActiveReviews({
      maxConcurrent: config.worker.concurrency,
      diskPath: config.monitorDiskPath ?? path.dirname(config.databasePath),
    });
    const reviews = snap.reviews.map((r) => {
      const tenant = db.getTenantById(r.tenantId);
      const plan = db.getTenantPlan(r.tenantId) ?? 'free';
      return {
        ...r,
        tenantSlug: tenant?.slug ?? null,
        tenantName: tenant?.name ?? null,
        plan,
        planLabel: publicPlanLabel(planFeatures(plan)),
        // Convenience totals for the panel — full review, not per-model.
        totalRssBytes: r.estimatedNodeRssShareBytes + r.childRssBytes,
      };
    });
    const queue = await getQueueDepth();
    const oldestWaitMs =
      queue.oldestQueuedAt && Number.isFinite(Date.parse(queue.oldestQueuedAt))
        ? Math.max(0, Date.now() - Date.parse(queue.oldestQueuedAt))
        : null;
    return c.json({
      ...snap,
      reviews,
      queue: { ...queue, oldestWaitMs },
      draining: existsSync(config.deployDrainPath),
    });
  });

  app.get('/superadmin/api/dead-letters', async (c) => {
    if (!authorizedAdmin(c, db, config)) return c.json({ error: 'unauthorized' }, 401);
    if (!queue?.listDeadLetters) return c.json({ deadLetters: [], replayAvailable: false });
    const records = await queue.listDeadLetters(100);
    return c.json({
      deadLetters: records.map(deadLetterView),
      replayAvailable: Boolean(queue.replayDeadLetter),
    });
  });

  app.post('/superadmin/api/dead-letters/:id/replay', async (c) => {
    if (!authorizedAdminMutation(c, db, config)) return c.json({ error: 'unauthorized' }, 401);
    const id = c.req.param('id');
    if (!id || id.length > 512) return c.json({ error: 'invalid dead-letter id' }, 400);
    if (!queue?.replayDeadLetter) return c.json({ error: 'dead-letter replay unavailable' }, 503);
    const replayed = await queue.replayDeadLetter(id);
    if (!replayed) return c.json({ error: 'dead letter is no longer available for replay' }, 409);
    return c.json({ replayed: true });
  });

  app.get('/superadmin/api/publication-claims', (c) => {
    if (!authorizedAdmin(c, db, config)) return c.json({ error: 'unauthorized' }, 401);
    return c.json(publications.list());
  });

  app.post('/superadmin/api/publication-claims/resolve', async (c) => {
    if (!authorizedAdminMutation(c, db, config)) return c.json({ error: 'unauthorized' }, 401);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return c.json({ error: 'invalid JSON body' }, 400);
    const user = sessionUser(c, db, config);
    const actor = user?.isSuperAdmin ? `user:${user.id}` : 'admin-secret';
    const result = publications.resolve(
      {
        tenantId: body.tenantId,
        runId: body.runId,
        artifactKey: body.artifactKey,
        action: body.action,
        reason: body.reason,
        result: body.result,
        resultProvided: Object.prototype.hasOwnProperty.call(body, 'result'),
      },
      actor,
    );
    if (result.kind === 'invalid') return c.json({ error: result.error }, 400);
    if (result.kind === 'conflict') {
      return c.json(
        { error: 'publication claim is active, resolved, or no longer available' },
        409,
      );
    }
    return c.json({ resolved: true, action: result.action });
  });

  app.get('/superadmin/api/costs', (c) => {
    if (!authorizedAdmin(c, db, config)) return c.json({ error: 'unauthorized' }, 401);
    const now = Date.now();
    const requestedDays = Number(c.req.query('days') ?? 30);
    const days = Number.isFinite(requestedDays)
      ? Math.min(Math.max(Math.floor(requestedDays), 1), 365)
      : 30;
    const until = c.req.query('until') ?? new Date(now).toISOString();
    const since = c.req.query('since') ?? new Date(now - days * 86_400_000).toISOString();
    const requestedLimit = Number(c.req.query('limit') ?? 5000);
    const recentLimit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(Math.floor(requestedLimit), 1), 5000)
      : 5000;
    if (
      !Number.isFinite(Date.parse(since)) ||
      !Number.isFinite(Date.parse(until)) ||
      Date.parse(since) >= Date.parse(until)
    ) {
      return c.json(
        { error: 'since and until must be valid ISO dates with since before until' },
        400,
      );
    }
    return c.json(metrics.costs({ since, until, recentLimit }));
  });

  app.post('/superadmin/api/operating-costs', async (c) => {
    if (!authorizedAdminMutation(c, db, config)) return c.json({ error: 'unauthorized' }, 401);
    const body = (await c.req.json().catch(() => ({}))) as {
      category?: string;
      amountCents?: number;
      note?: string;
    };
    const result = metrics.validateOperatingCost(body);
    if (result.kind === 'invalid')
      return c.json({ error: 'category and amountCents are invalid' }, 400);
    return c.json({ cost: result.cost });
  });

  app.delete('/superadmin/api/operating-costs/:category', (c) => {
    if (!authorizedAdminMutation(c, db, config)) return c.json({ error: 'unauthorized' }, 401);
    return c.json({ deleted: metrics.removeOperatingCost(c.req.param('category')) });
  });

  app.post('/superadmin/api/revenue/sync', async (c) => {
    if (!authorizedAdminMutation(c, db, config)) return c.json({ error: 'unauthorized' }, 401);
    const secret = config.billing.stripe.secretKey;
    if (!secret) return c.json({ error: 'Stripe is not configured' }, 501);
    return c.json(
      await new RevenueReconciliationService(db, stripeObjectClient(secret)).reconcile(),
    );
  });

  app.get('/superadmin/api/scoreboard', (c) => {
    if (!authorizedAdmin(c, db, config)) return c.json({ error: 'unauthorized' }, 401);
    return c.json(scoreboards.read().scoreboard);
  });

  app.post('/superadmin/api/scoreboard/rebuild', async (c) => {
    if (!authorizedAdminMutation(c, db, config)) return c.json({ error: 'unauthorized' }, 401);
    const requestedPrs = Number(c.req.query('prs') ?? 60);
    const maxPrs =
      Number.isFinite(requestedPrs) && requestedPrs > 0
        ? Math.min(Math.floor(requestedPrs), 200)
        : 60;
    const github = dependencies.githubConfig;
    if (!github) return c.json({ error: 'GitHub App is not configured' }, 501);
    const result = await scoreboards.rebuild(github, maxPrs);
    if (result.kind !== 'ok') {
      return c.json(
        {
          error: result.kind === 'no_targets' ? 'no repos connected' : 'all repos failed to score',
        },
        result.kind === 'no_targets' ? 400 : 502,
      );
    }
    return c.json(result.scoreboard);
  });

  // List preserved snapshots: filename encodes timestamp + rules hash, so a
  // performance comparison across config eras is a two-file diff.
  app.get('/superadmin/api/scoreboard/history', (c) => {
    if (!authorizedAdmin(c, db, config)) return c.json({ error: 'unauthorized' }, 401);
    return c.json({ snapshots: scoreboards.history() });
  });

  app.get('/superadmin/api/scoreboard/history/:file', (c) => {
    if (!authorizedAdmin(c, db, config)) return c.json({ error: 'unauthorized' }, 401);
    const result = scoreboards.readHistory(c.req.param('file'));
    if (result.kind !== 'ok' && result.kind !== 'missing') {
      const status = result.kind === 'invalid_name' ? 400 : result.kind === 'not_found' ? 404 : 500;
      return c.json(
        {
          error:
            result.kind === 'invalid_name'
              ? 'invalid snapshot name'
              : result.kind === 'not_found'
                ? 'snapshot not found'
                : 'snapshot unreadable',
        },
        status,
      );
    }
    return c.json(result.scoreboard);
  });

  // Deep-vs-normal scorecard: reads review_runs (deep flag + per-run new
  // findings) and pairs normal-then-deep runs on the same commit — deep's
  // marginal severe-finding rate is the evidence for its 2× price.
  app.get('/superadmin/api/deep-scorecard', (c) => {
    if (!authorizedAdmin(c, db, config)) return c.json({ error: 'unauthorized' }, 401);
    return c.json(metrics.deepScorecard());
  });

  return app;
}
