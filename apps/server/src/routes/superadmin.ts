import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { Hono } from 'hono';
import { createAppDatabase, type AppDatabase } from '@orvex-review/store';
import { createInstallationOctokit, loadGitHubConfigFromEnv } from '@orvex-review/github';
import { buildScoreboard, type Scoreboard } from '../scoreboard.js';
import { buildDeepScorecard } from '../deep-scorecard.js';
import { authorizedAdmin, authorizedAdminMutation } from './admin-auth.js';
import { pageShell } from './pages.js';
import { sessionUser } from './session.js';
import { planFeatures, publicPlanLabel } from '@orvex-review/tenants';
import { sampleActiveReviews } from '../active-reviews.js';
import { getQueueDepth, maxConcurrentReviews } from '../queue-runner.js';

function emptyScoreboard(): Scoreboard {
  return {
    repo: '(none)',
    generatedAt: '',
    prsAnalyzed: 0,
    bots: {},
    clusters: { total: 0, orvexMissed: [], orvexUnique: [] },
    perPr: [],
  };
}

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

function scoreboardPath(): string {
  const dir = process.env.STORE_PATH ? path.dirname(process.env.STORE_PATH) : path.resolve('./data');
  return path.join(dir, 'scoreboard.json');
}

export function superadminRoutes(db: AppDatabase = createAppDatabase()) {
  const app = new Hono();

  app.get('/superadmin', (c) => {
    const user = sessionUser(c, db);
    if (!user) return c.redirect('/auth/login?next=/superadmin');
    if (!user.isSuperAdmin) {
      return c.html(pageShell('Access denied', '<h1>Access denied</h1><p>This account is not a super administrator.</p>', user), 403);
    }
    return c.html(PAGE);
  });

  /**
   * Live host + per-client-review resource snapshot.
   * One row per FULL in-flight review (not per model pass). Polls from the
   * super-admin UI so operators can watch concurrent client load.
   */
  app.get('/superadmin/api/active-reviews', async (c) => {
    if (!authorizedAdmin(c, db)) return c.json({ error: 'unauthorized' }, 401);
    const snap = sampleActiveReviews({ maxConcurrent: maxConcurrentReviews() });
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
      draining: existsSync(process.env.ORVEX_DEPLOY_DRAIN_PATH ?? '/home/orvex/orvex-data/deploy-drain'),
    });
  });

  app.get('/superadmin/api/costs', (c) => {
    if (!authorizedAdmin(c, db)) return c.json({ error: 'unauthorized' }, 401);
    const now = Date.now();
    const requestedDays = Number(c.req.query('days') ?? 30);
    const days = Number.isFinite(requestedDays) ? Math.min(Math.max(Math.floor(requestedDays), 1), 365) : 30;
    const until = c.req.query('until') ?? new Date(now).toISOString();
    const since = c.req.query('since') ?? new Date(now - days * 86_400_000).toISOString();
    const requestedLimit = Number(c.req.query('limit') ?? 5000);
    const recentLimit = Number.isFinite(requestedLimit) ? Math.min(Math.max(Math.floor(requestedLimit), 1), 5000) : 5000;
    if (!Number.isFinite(Date.parse(since)) || !Number.isFinite(Date.parse(until)) || Date.parse(since) >= Date.parse(until)) {
      return c.json({ error: 'since and until must be valid ISO dates with since before until' }, 400);
    }
    const planPrices = Object.fromEntries(
      ['free', 'review', 'review-plus', 'verify-lite', 'verify', 'enterprise'].map((id) => [
        id,
        planFeatures(id).monthlyPriceCents ?? 0,
      ]),
    );
    const analytics = db.getSuperadminCostAnalytics(since, until, planPrices, recentLimit);
    const rangeDays = Math.max(1 / 24, (Date.parse(until) - Date.parse(since)) / 86_400_000);
    const windowFactor = rangeDays / 30;
    const modeledRevenueForWindowUsd = analytics.overview.modeledMonthlyRevenueUsd * windowFactor;
    const actualProfitUsd = analytics.overview.actualRevenueUsd - analytics.overview.costUsd;
    const modeledProfitUsd = modeledRevenueForWindowUsd - analytics.overview.costUsd;
    const actualNetProfitUsd = actualProfitUsd - analytics.overview.allocatedFixedCostUsd;
    const modeledFixedCostForWindowUsd = analytics.overview.monthlyFixedCostUsd * windowFactor;
    const modeledNetProfitUsd = modeledProfitUsd - modeledFixedCostForWindowUsd;
    return c.json({
      ...analytics,
      overview: {
        ...analytics.overview,
        actualProfitUsd,
        actualMarginPct:
          analytics.overview.actualRevenueUsd > 0
            ? (actualProfitUsd / analytics.overview.actualRevenueUsd) * 100
            : null,
        actualNetProfitUsd,
        actualNetMarginPct:
          analytics.overview.actualRevenueUsd > 0
            ? (actualNetProfitUsd / analytics.overview.actualRevenueUsd) * 100
            : null,
        modeledProfitUsd,
        modeledRevenueForWindowUsd,
        modeledFixedCostForWindowUsd,
        modeledMarginPct:
          modeledRevenueForWindowUsd > 0
            ? (modeledProfitUsd / modeledRevenueForWindowUsd) * 100
            : null,
        modeledNetProfitUsd,
        modeledNetMarginPct:
          modeledRevenueForWindowUsd > 0
            ? (modeledNetProfitUsd / modeledRevenueForWindowUsd) * 100
            : null,
        telemetryCoveragePct:
          analytics.overview.runs > 0
            ? (analytics.overview.instrumentedRuns / analytics.overview.runs) * 100
            : 0,
      },
      byTenant: analytics.byTenant.map((row) => {
        const profitUsd = row.actualRevenueUsd - row.costUsd;
        return {
          ...row,
          planLabel: publicPlanLabel(planFeatures(row.plan)),
          actualProfitUsd: profitUsd,
          actualMarginPct: row.actualRevenueUsd > 0 ? (profitUsd / row.actualRevenueUsd) * 100 : null,
          modeledRevenueForWindowUsd: row.modeledMonthlyRevenueUsd * windowFactor,
          modeledProfitUsd: row.modeledMonthlyRevenueUsd * windowFactor - row.costUsd,
        };
      }),
    });
  });

  app.post('/superadmin/api/operating-costs', async (c) => {
    if (!authorizedAdminMutation(c, db)) return c.json({ error: 'unauthorized' }, 401);
    const body = (await c.req.json().catch(() => ({}))) as {
      category?: string;
      amountCents?: number;
      note?: string;
    };
    const category = body.category?.trim().slice(0, 80);
    const amountCents = Number(body.amountCents);
    if (!category || !/^[a-zA-Z0-9][a-zA-Z0-9 _./-]*$/.test(category)) {
      return c.json({ error: 'category is required and may contain letters, numbers, spaces, _ . / -' }, 400);
    }
    if (!Number.isFinite(amountCents) || amountCents < 0 || amountCents > 100_000_000) {
      return c.json({ error: 'amountCents must be between 0 and 100000000' }, 400);
    }
    return c.json({ cost: db.upsertPlatformCost({ category, amountCents: Math.round(amountCents), note: body.note?.trim().slice(0, 240) }) });
  });

  app.delete('/superadmin/api/operating-costs/:category', (c) => {
    if (!authorizedAdminMutation(c, db)) return c.json({ error: 'unauthorized' }, 401);
    return c.json({ deleted: db.deletePlatformCost(c.req.param('category')) });
  });

  app.post('/superadmin/api/revenue/sync', async (c) => {
    if (!authorizedAdminMutation(c, db)) return c.json({ error: 'unauthorized' }, 401);
    const secret = process.env.STRIPE_SECRET_KEY;
    if (!secret) return c.json({ error: 'Stripe is not configured' }, 501);
    let synced = 0;
    const errors: string[] = [];
    const customers = db.listStripeCustomers();
    for (const customer of customers) {
      try {
        const invoices = await listStripeObjects<{
          id?: string;
          amount_paid?: number;
          currency?: string;
          customer?: string | { id?: string };
          subscription?: string | { id?: string };
          status_transitions?: { paid_at?: number };
        }>('/v1/invoices', { customer: customer.customerId, status: 'paid' }, secret);
        for (const invoice of invoices) {
          if (!invoice.id || !Number.isFinite(invoice.amount_paid) || (invoice.amount_paid ?? 0) <= 0) continue;
          const added = db.recordStripeRevenueEvent({
            eventId: `backfill:${invoice.id}`,
            eventType: 'invoice.paid',
            invoiceId: invoice.id,
            tenantId: customer.tenantId,
            customerId: typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id ?? customer.customerId,
            subscriptionId:
              typeof invoice.subscription === 'string' ? invoice.subscription : invoice.subscription?.id,
            amountCents: invoice.amount_paid ?? 0,
            currency: invoice.currency ?? 'usd',
            occurredAt: invoice.status_transitions?.paid_at
              ? new Date(invoice.status_transitions.paid_at * 1000).toISOString()
              : new Date().toISOString(),
          });
          if (added) synced++;
        }

        // Stripe's charge.refunded webhook exposes a cumulative
        // amount_refunded. Reconcile charge deltas so repeated/partial refunds
        // are not subtracted more than once.
        const charges = await listStripeObjects<{
          id?: string;
          amount_refunded?: number;
          currency?: string;
          customer?: string | { id?: string };
          subscription?: string | { id?: string };
          created?: number;
        }>('/v1/charges', { customer: customer.customerId }, secret);
        for (const charge of charges) {
          if (!charge.id) continue;
          const cumulative = Math.max(0, Number(charge.amount_refunded ?? 0));
          const prior = db.sumStripeRefundsForCharge(charge.id);
          const delta = Math.max(0, cumulative - prior);
          if (delta <= 0) continue;
          const refunds = await listStripeObjects<{
            id?: string;
            amount?: number;
            currency?: string;
            created?: number;
          }>('/v1/refunds', { charge: charge.id }, secret);
          let uncovered = prior;
          let recorded = 0;
          for (const refund of [...refunds].sort((a, b) => (a.created ?? 0) - (b.created ?? 0))) {
            const amount = Math.max(0, Number(refund.amount ?? 0));
            const covered = Math.min(amount, uncovered);
            uncovered -= covered;
            const newAmount = amount - covered;
            if (!refund.id || newAmount <= 0) continue;
            const added = db.recordStripeRevenueEvent({
              eventId: `backfill:refund:${refund.id}`,
              eventType: 'charge.refunded',
              invoiceId: charge.id,
              tenantId: customer.tenantId,
              customerId:
                typeof charge.customer === 'string' ? charge.customer : charge.customer?.id ?? customer.customerId,
              subscriptionId:
                typeof charge.subscription === 'string' ? charge.subscription : charge.subscription?.id,
              amountCents: -newAmount,
              currency: refund.currency ?? charge.currency ?? 'usd',
              occurredAt: refund.created ? new Date(refund.created * 1000).toISOString() : new Date().toISOString(),
            });
            if (added) {
              synced++;
              recorded += newAmount;
            }
          }
          // Older accounts may not expose individual refunds to the API key.
          // Preserve the cumulative delta in that case rather than silently
          // understating losses; the charge timestamp is the only safe fallback.
          if (recorded < delta) {
            const added = db.recordStripeRevenueEvent({
              eventId: `backfill:refund:${charge.id}:${cumulative}`,
              eventType: 'charge.refunded',
              invoiceId: charge.id,
              tenantId: customer.tenantId,
              customerId:
                typeof charge.customer === 'string' ? charge.customer : charge.customer?.id ?? customer.customerId,
              subscriptionId:
                typeof charge.subscription === 'string' ? charge.subscription : charge.subscription?.id,
              amountCents: -(delta - recorded),
              currency: charge.currency ?? 'usd',
              occurredAt: charge.created ? new Date(charge.created * 1000).toISOString() : new Date().toISOString(),
            });
            if (added) synced++;
          }
        }
      } catch (err) {
        errors.push(`${customer.customerId}: ${(err as Error).message}`);
      }
    }
    return c.json({ customers: customers.length, synced, errors });
  });

  app.get('/superadmin/api/scoreboard', (c) => {
    if (!authorizedAdmin(c, db)) return c.json({ error: 'unauthorized' }, 401);
    try {
      return c.json(JSON.parse(readFileSync(scoreboardPath(), 'utf8')) as Scoreboard);
    } catch {
      // Empty placeholder (200) so the dashboard can still load costs / live /
      // deep scorecard without a hard failure before the first rebuild.
      return c.json({ ...emptyScoreboard(), empty: true });
    }
  });

  app.post('/superadmin/api/scoreboard/rebuild', async (c) => {
    if (!authorizedAdminMutation(c, db)) return c.json({ error: 'unauthorized' }, 401);
    const requestedPrs = Number(c.req.query('prs') ?? 60);
    const maxPrs =
      Number.isFinite(requestedPrs) && requestedPrs > 0 ? Math.min(Math.floor(requestedPrs), 200) : 60;
    const github = loadGitHubConfigFromEnv();
    // ALL connected repos across ALL tenants (operator-only view, so
    // cross-tenant aggregation is appropriate here and nowhere else).
    const targets = db.listScanTargets();
    if (targets.length === 0) return c.json({ error: 'no repos connected' }, 400);

    // Stamp the snapshot with the ruleset hash so results are attributable to a
    // CONFIG ERA — "were the old settings outperforming?" becomes answerable by
    // comparing snapshots with different hashes (see /scoreboard/history).
    let rulesHash = 'unknown';
    for (const cand of [path.resolve('rules/orvex-rules.md'), path.resolve('../../rules/orvex-rules.md')]) {
      try {
        rulesHash = createHash('sha256').update(readFileSync(cand)).digest('hex').slice(0, 12);
        break;
      } catch {
        /* try next candidate (cwd differs under pm2: repo root vs apps/server) */
      }
    }

    const boards = [];
    for (const t of targets) {
      const octokit = createInstallationOctokit(github, t.installationId);
      try {
        const b = await buildScoreboard(octokit, t.owner, t.name, maxPrs);
        b.rulesHash = rulesHash;
        boards.push(b);
      } catch (err) {
        console.warn(`[superadmin] scoreboard failed for ${t.fullName}:`, (err as Error).message);
      }
    }
    if (boards.length === 0) return c.json({ error: 'all repos failed to score' }, 502);
    // Single-repo shape stays backward-compatible; multi-repo adds `repos`.
    const primary = boards[0];
    const combined = boards.length === 1 ? primary : { ...primary, repos: boards.map((b) => ({ repo: b.repo, prsAnalyzed: b.prsAnalyzed, bots: b.bots, clustersTotal: b.clusters.total })) };

    mkdirSync(path.dirname(scoreboardPath()), { recursive: true });
    writeFileSync(scoreboardPath(), JSON.stringify(combined, null, 2));
    // History snapshot: every rebuild is preserved so config eras stay comparable.
    const histDir = path.join(path.dirname(scoreboardPath()), 'scoreboard-history');
    mkdirSync(histDir, { recursive: true });
    writeFileSync(
      path.join(histDir, `${new Date().toISOString().replace(/[:.]/g, '-')}_${rulesHash}.json`),
      JSON.stringify(combined, null, 2),
    );
    return c.json(combined);
  });

  // List preserved snapshots: filename encodes timestamp + rules hash, so a
  // performance comparison across config eras is a two-file diff.
  app.get('/superadmin/api/scoreboard/history', (c) => {
    if (!authorizedAdmin(c, db)) return c.json({ error: 'unauthorized' }, 401);
    const histDir = path.join(path.dirname(scoreboardPath()), 'scoreboard-history');
    if (!existsSync(histDir)) return c.json({ snapshots: [] });
    const snapshots = readdirSync(histDir)
      .filter((name) => name.endsWith('.json'))
      .sort()
      .reverse()
      .map((name) => {
        const base = name.replace(/\.json$/i, '');
        const idx = base.lastIndexOf('_');
        return {
          file: name,
          at: idx >= 0 ? base.slice(0, idx) : base,
          rulesHash: idx >= 0 ? base.slice(idx + 1) : null,
        };
      });
    return c.json({ snapshots });
  });

  app.get('/superadmin/api/scoreboard/history/:file', (c) => {
    if (!authorizedAdmin(c, db)) return c.json({ error: 'unauthorized' }, 401);
    const file = c.req.param('file');
    if (!file || file.includes('/') || file.includes('..') || !file.endsWith('.json')) {
      return c.json({ error: 'invalid snapshot name' }, 400);
    }
    const histDir = path.join(path.dirname(scoreboardPath()), 'scoreboard-history');
    const full = path.join(histDir, file);
    if (!existsSync(full)) return c.json({ error: 'snapshot not found' }, 404);
    try {
      return c.json(JSON.parse(readFileSync(full, 'utf8')) as Scoreboard);
    } catch {
      return c.json({ error: 'snapshot unreadable' }, 500);
    }
  });

  // Deep-vs-normal scorecard: reads review_runs (deep flag + per-run new
  // findings) and pairs normal-then-deep runs on the same commit — deep's
  // marginal severe-finding rate is the evidence for its 2× price.
  app.get('/superadmin/api/deep-scorecard', (c) => {
    if (!authorizedAdmin(c, db)) return c.json({ error: 'unauthorized' }, 401);
    return c.json(buildDeepScorecard(db.listScorecardRuns(1000)));
  });

  return app;
}

async function listStripeObjects<T>(
  endpoint: string,
  filters: Record<string, string>,
  secret: string,
): Promise<T[]> {
  const objects: T[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < 1000; page++) {
    const query = new URLSearchParams({ ...filters, limit: '100' });
    if (startingAfter) query.set('starting_after', startingAfter);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    let response: Response;
    try {
      response = await fetch(`https://api.stripe.com${endpoint}?${query.toString()}`, {
        signal: controller.signal,
        headers: { Authorization: `Bearer ${secret}` },
      });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) throw new Error(`Stripe ${endpoint} ${response.status}`);
    const payload = (await response.json()) as { data?: T[]; has_more?: boolean };
    const pageItems = payload.data ?? [];
    objects.push(...pageItems);
    if (!payload.has_more || pageItems.length === 0) break;
    const last = pageItems[pageItems.length - 1] as T & { id?: string };
    if (!last.id) break;
    startingAfter = last.id;
    if (page === 999) throw new Error(`Stripe ${endpoint} pagination exceeded 1000 pages`);
  }
  return objects;
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Orvex · Super Admin</title>
<style>
:root{--bg:#0b0e13;--panel:#121720;--panel2:#171d28;--ink:#eef2f7;--ink2:#9ba7b8;--muted:#697688;--line:#26303e;--accent:#6f82ff;--bad:#f07167;--good:#4fd18b;--warn:#e9b65d}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
main{max-width:1380px;margin:0 auto;padding:30px 24px 90px}
h1{font-size:24px;letter-spacing:-.02em;margin:0}h2{font-size:13px;margin:32px 0 10px;color:var(--ink2);text-transform:uppercase;letter-spacing:.09em}
.eyebrow{font:11px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.13em;text-transform:uppercase;color:var(--accent);margin-bottom:7px}
.subtitle{color:var(--ink2);margin:4px 0 0}.panel{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin:10px 0}
.hero{display:flex;justify-content:space-between;gap:20px;align-items:flex-end;margin-bottom:22px}.toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.live-row{display:grid;grid-template-columns:1.4fr .7fr .7fr .7fr .7fr .6fr;gap:10px;padding:12px 0;border-bottom:1px solid var(--line);align-items:start}
.live-row:last-child{border-bottom:0}.live-title{font-weight:650}.pulse{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--good);margin-right:7px;box-shadow:0 0 0 0 rgba(79,209,139,.55);animation:pulse 1.6s infinite}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(79,209,139,.45)}70%{box-shadow:0 0 0 10px rgba(79,209,139,0)}100%{box-shadow:0 0 0 0 rgba(79,209,139,0)}}
.barwrap{height:8px;background:#202937;border-radius:8px;overflow:hidden;margin-top:6px}.barfill{height:100%;background:var(--accent)}.barfill.warn{background:var(--warn)}.barfill.bad{background:var(--bad)}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
th,td{padding:9px 10px;text-align:left;border-bottom:1px solid var(--line);font-size:13px;vertical-align:top}
th{color:var(--ink2);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.06em;white-space:nowrap}
td.num,th.num{text-align:right}.muted{color:var(--muted)}.right{text-align:right}.nowrap{white-space:nowrap}
input,button,select{font:inherit;border-radius:8px;border:1px solid var(--line);background:#0d121a;color:var(--ink);padding:8px 12px}
button{background:var(--accent);border:0;cursor:pointer;font-weight:650}button.secondary{background:#202938;border:1px solid var(--line)}
button:disabled{opacity:.5;cursor:default}select{cursor:pointer}
.badge{display:inline-block;padding:2px 8px;border-radius:99px;font-size:11px;border:1px solid var(--line);color:var(--ink2)}
.miss,.negative{color:var(--bad)}.unique,.positive{color:var(--good)}.warning{color:var(--warn)}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--ink2)}
#status{color:var(--ink2);font-size:13px;margin-left:4px}.kpis{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:10px}
.kpi{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:15px 16px;min-height:92px}.kpi .value{font-size:25px;font-weight:720;letter-spacing:-.03em}.kpi .label{color:var(--ink2);font-size:12px;margin-top:4px}
.kpi.good .value{color:var(--good)}.kpi.bad .value{color:var(--bad)}.kpi.warn .value{color:var(--warn)}.kpi.info .value{color:var(--accent)}
.split{display:grid;grid-template-columns:1.2fr .8fr;gap:12px}.section-head{display:flex;justify-content:space-between;align-items:baseline;gap:12px}.section-head .note{font-size:12px;color:var(--muted)}
.trend{display:grid;gap:7px}.trend-row{display:grid;grid-template-columns:86px 1fr 90px;gap:10px;align-items:center;font-size:12px}.track{height:9px;background:#202937;border-radius:8px;overflow:hidden}.fill{height:100%;background:var(--accent);border-radius:8px}.fill.revenue{background:var(--good)}
.margin-bar{display:inline-block;height:6px;min-width:2px;vertical-align:middle;border-radius:6px;background:var(--good)}.margin-bar.bad{background:var(--bad)}
details.run{border-top:1px solid var(--line);padding:9px 0}details.run:first-child{border-top:0}details.run summary{cursor:pointer;list-style:none;display:grid;grid-template-columns:120px 1fr 100px 100px;gap:12px;align-items:center}details.run summary::-webkit-details-marker{display:none}
.run-meta{color:var(--ink2);font-size:12px}.run-cost{font-weight:650;text-align:right}.mini{font-size:11px;color:var(--muted)}
.empty{color:var(--muted);padding:14px 0}.coverage{font-size:12px;color:var(--ink2)}.coverage strong{color:var(--ink)}
@media (max-width:1000px){.kpis{grid-template-columns:repeat(3,1fr)}.split{grid-template-columns:1fr}.hero{align-items:flex-start;flex-direction:column}}
@media (max-width:620px){main{padding:22px 14px 60px}.kpis{grid-template-columns:repeat(2,1fr)}.hero h1{font-size:21px}.panel{padding:13px}.trend-row{grid-template-columns:62px 1fr 72px}details.run summary{grid-template-columns:1fr 80px}.run-meta{grid-column:1/-1}}
</style></head><body><main>
<div class="hero">
  <div><div class="eyebrow">Operator console / financial control</div><h1>Super Admin · Operations & Profitability</h1><p class="subtitle">Know what every review costs, who is profitable, and where spend is escaping.</p></div>
  <div class="toolbar"><select id="range" aria-label="Analytics range"><option value="1">Last 24 hours</option><option value="7">Last 7 days</option><option value="30" selected>Last 30 days</option><option value="90">Last 90 days</option></select><button id="refresh" class="secondary">Refresh data</button><button id="syncRevenue" class="secondary">Sync Stripe revenue</button><button id="rebuild" class="secondary">Rebuild scoreboard</button><button id="security" class="secondary">Account security</button><span id="status"></span></div>
</div>
<div id="live"></div>
<div id="costs"></div>
<div id="deep"></div>
<div id="content"></div>
<script>
const $=(s)=>document.querySelector(s);
async function api(p,opts){const r=await fetch(p,{...opts,credentials:'same-origin'});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||r.status);return j}
function esc(s){return String(s??'').replace(/[&<>"]/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
function money(v){return '$'+Number(v||0).toFixed(2)}
function currencyMoney(currency,v){return String(currency||'').toUpperCase()+' '+Number(v||0).toFixed(2)}
function pct(v){return v===null||v===undefined?'—':Number(v).toFixed(1)+'%'}
function tokens(v){v=Number(v||0);if(v>=1000000)return (v/1000000).toFixed(2)+'M';if(v>=1000)return (v/1000).toFixed(1)+'k';return String(v)}
function marginClass(v){return v===null||v===undefined?'':(v<0?'negative':'positive')}
function bytes(v){v=Number(v||0);if(v>=1073741824)return (v/1073741824).toFixed(2)+' GiB';if(v>=1048576)return (v/1048576).toFixed(1)+' MiB';if(v>=1024)return (v/1024).toFixed(0)+' KiB';return v+' B'}
function elapsed(ms){ms=Number(ms||0);const s=Math.floor(ms/1000);if(s<60)return s+'s';const m=Math.floor(s/60);const r=s%60;if(m<60)return m+'m '+r+'s';return Math.floor(m/60)+'h '+(m%60)+'m'}
function usageBar(used,total,warnAt,badAt){const p=total>0?Math.min(100,used/total*100):0;const cls=p>=badAt?'bad':(p>=warnAt?'warn':'');return '<div class="barwrap"><div class="barfill '+cls+'" style="width:'+p.toFixed(1)+'%"></div></div><div class="mini">'+bytes(used)+' / '+bytes(total)+' ('+p.toFixed(0)+'%)</div>'}
function renderLive(d){
  const hst=d.host||{}; const mem=hst.memory||{}; const disk=hst.disk||{}; const w=hst.worker||{};
  const q=d.queue||{}; const load=(hst.loadAverage||[0,0,0]).map((x)=>Number(x).toFixed(2)).join(' / ');
  let html='<h2>Live server · active client reviews</h2>';
  html+='<div class="kpis">';
  html+='<div class="kpi info"><div class="value">'+(w.activeReviews||0)+' / '+(w.maxConcurrentReviews||0)+'</div><div class="label">Active reviews / capacity</div></div>';
  html+='<div class="kpi '+(Number(q.queued||0)+Number(q.waitingOnPr||0)>0?'warn':'')+'"><div class="value">'+(Number(q.queued||0)+Number(q.waitingOnPr||0))+'</div><div class="label">Queue depth (ready + waiting)</div></div>';
  html+='<div class="kpi"><div class="value">'+(q.oldestWaitMs==null?'—':elapsed(q.oldestWaitMs))+'</div><div class="label">Oldest queued wait</div></div>';
  html+='<div class="kpi"><div class="value">'+bytes(mem.availableBytes)+'</div><div class="label">RAM available</div></div>';
  html+='<div class="kpi '+(Number(mem.usedBytes)/Math.max(1,Number(mem.totalBytes))>0.85?'warn':'')+'"><div class="value">'+bytes(mem.usedBytes)+'</div><div class="label">RAM used (of '+bytes(mem.totalBytes)+')</div></div>';
  html+='<div class="kpi"><div class="value">'+load+'</div><div class="label">Load 1 / 5 / 15 · '+esc(hst.cpuCount)+' CPUs</div></div>';
  html+='</div>';
  html+='<div class="split"><div class="panel"><div class="section-head"><strong>Host memory</strong><span class="note">available = what Linux can give apps</span></div>'+usageBar(mem.usedBytes,mem.totalBytes,75,90);
  if(mem.swapTotalBytes>0)html+='<div class="mini" style="margin-top:8px">Swap used '+bytes(mem.swapUsedBytes)+' / '+bytes(mem.swapTotalBytes)+'</div>';
  html+='</div><div class="panel"><div class="section-head"><strong>Queue pressure</strong><span class="note">ready '+Number(q.queued||0)+' · waiting on PR '+Number(q.waitingOnPr||0)+' · backend in-flight '+Number(q.inFlight||0)+'</span></div>';
  html+='<p class="muted" style="margin:0">Worker Node RSS <strong>'+bytes(w.rssBytes)+'</strong> · disk free <strong>'+bytes(disk.availableBytes)+'</strong> · path <span class="mono">'+esc(disk.path||'')+'</span></p>';
  if(Number(q.queued||0)+Number(q.waitingOnPr||0)===0)html+='<p class="empty" style="margin:10px 0 0">Queue is idle. New reviews appear here as soon as they enqueue.</p>';
  else html+='<p class="warning" style="margin:10px 0 0">Work is waiting. Oldest ready job has waited '+(q.oldestWaitMs==null?'an unknown time':elapsed(q.oldestWaitMs))+'. Capacity is '+(w.activeReviews||0)+'/'+(w.maxConcurrentReviews||0)+'.</p>';
  html+='</div></div>';
  html+='<div class="panel"><div class="section-head"><strong>'+(d.reviews||[]).length+' running client review(s)</strong><span class="note">'+(d.draining?'DRAINING · ':'')+'auto-refresh every 3s · per full review, not per model pass</span></div>';
  if(!(d.reviews||[]).length){html+='<div class="empty">No reviews running right now. When a client review starts, it appears here with elapsed time, checkout disk, and attributed process RAM.</div>';}
  else{
    html+='<div class="live-row muted" style="padding-top:0"><div>Client / PR</div><div>Elapsed</div><div>Checkout disk</div><div>Review RAM</div><div>Codex children</div><div>Kind</div></div>';
    for(const r of (d.reviews||[])){
      const client=r.tenantName||r.tenantSlug||r.tenantId;
      html+='<div class="live-row">';
      html+='<div><span class="pulse"></span><div class="live-title">'+esc(client)+'</div><div class="mono">'+esc(r.owner)+'/'+esc(r.repo)+'#'+r.pr+' @ '+esc(String(r.headSha||'').slice(0,7))+'</div><div class="mini"><span class="badge">'+esc(r.planLabel||r.plan)+'</span> · run '+(r.runId?esc(String(r.runId).slice(0,8)):'pending')+(r.deep?' · deep':'')+'</div></div>';
      html+='<div><strong>'+elapsed(r.elapsedMs)+'</strong><div class="mini">since '+esc(String(r.startedAt||'').slice(11,19))+'Z</div></div>';
      html+='<div><strong>'+bytes(r.checkoutDiskBytes)+'</strong><div class="mini">agent / runtime dirs</div></div>';
      html+='<div><strong>'+bytes(r.totalRssBytes)+'</strong><div class="mini">node share '+bytes(r.estimatedNodeRssShareBytes)+' + children '+bytes(r.childRssBytes)+'</div></div>';
      html+='<div><strong>'+r.childCount+'</strong><div class="mini">'+(r.children||[]).map((c)=>'pid '+c.pid+' '+bytes(c.rssBytes)).join('<br>')+'</div></div>';
      html+='<div><span class="badge">'+esc(r.kind)+'</span><div class="mini">'+esc(r.action)+'</div></div>';
      html+='</div>';
    }
  }
  html+='<p class="muted" style="margin:12px 0 0">Node worker RSS is shared across concurrent reviews; the panel shows an equal-share estimate plus any Codex/runtime child process RSS attributed to that review. LLM tokens and $ cost remain in the profitability section below.</p></div>';
  $('#live').innerHTML=html;
}
function renderCosts(d){
  const o=d.overview||{};
  const avg=o.runsWithCost?o.costUsd/o.runsWithCost:0;
  const totalCalls=(d.byModel||[]).reduce((s,m)=>s+Number(m.calls||0),0);
  const avgCall=totalCalls?o.costUsd/totalCalls:0;
  const maxDaily=Math.max(1,...(d.daily||[]).map(x=>Number(x.costUsd||0)));
  const maxRevenue=Math.max(1,...(d.daily||[]).map(x=>Number(x.actualRevenueUsd||0)));
  const costPerRunSeries=(d.daily||[]).map((day)=>{
    const runs=Number(day.runs||0); const cost=Number(day.costUsd||0);
    return {day:day.day, value:runs?cost/runs:0, runs, cost};
  });
  const maxCostPerRun=Math.max(0.0001,...costPerRunSeries.map((x)=>x.value));
  const maxModelCalls=Math.max(1,...(d.byModel||[]).map((m)=>Number(m.calls||0)));
  let h='<h2>Profit pulse · '+esc(d.since.slice(0,10))+' → '+esc(d.until.slice(0,10))+'</h2>';
  h+='<div class="kpis">';
  h+='<div class="kpi info"><div class="value">'+money(o.actualRevenueUsd)+'</div><div class="label">Actual Stripe revenue</div></div>';
  h+='<div class="kpi"><div class="value">'+money(o.modeledMonthlyRevenueUsd)+'</div><div class="label">Modeled active MRR</div></div>';
  h+='<div class="kpi warn"><div class="value">'+money(o.costUsd)+'</div><div class="label">LLM COGS</div></div>';
  h+='<div class="kpi '+(o.actualProfitUsd<0?'bad':'good')+'"><div class="value">'+money(o.actualProfitUsd)+'</div><div class="label">Contribution profit</div></div>';
  h+='<div class="kpi '+(o.actualMarginPct!==null&&o.actualMarginPct<0?'bad':'good')+'"><div class="value">'+pct(o.actualMarginPct)+'</div><div class="label">Actual gross margin</div></div>';
  h+='<div class="kpi"><div class="value">'+money(avg)+'</div><div class="label">Average cost / run</div></div>';
  h+='</div>';
  h+='<div class="panel"><div class="coverage"><strong>'+o.runs+'</strong> runs · <strong>'+o.completedRuns+'</strong> completed · <strong>'+o.failedRuns+'</strong> failed · <strong>'+o.skippedRuns+'</strong> skipped · <strong>'+tokens(o.inputTokens)+'</strong> input · <strong>'+tokens(o.outputTokens)+'</strong> output · <strong>'+totalCalls+'</strong> model calls · avg <strong>'+money(avgCall)+'</strong> / call · telemetry coverage <strong>'+pct(o.telemetryCoveragePct)+'</strong> · legacy unattributed spend <strong>'+money(o.legacyCostUsd)+'</strong></div></div>';
  h+='<div class="split"><div class="panel"><div class="section-head"><strong>Daily cash versus COGS</strong><span class="note">actual Stripe revenue · model spend</span></div><div class="trend">';
  for(const day of (d.daily||[])){const cost=Number(day.costUsd||0),rev=Number(day.actualRevenueUsd||0);h+='<div class="trend-row"><span class="mono">'+esc(day.day.slice(5))+'</span><div><div class="track" title="COGS '+money(cost)+'"><div class="fill" style="width:'+Math.min(100,cost/maxDaily*100)+'%"></div></div><div class="track" title="Revenue '+money(rev)+'" style="margin-top:3px"><div class="fill revenue" style="width:'+Math.min(100,rev/maxRevenue*100)+'%"></div></div></div><span class="right">'+money(rev)+' / '+money(cost)+'</span></div>'}
  h+='</div></div><div class="panel"><div class="section-head"><strong>Margin controls</strong><span class="note">operator attention</span></div>';
  if(o.actualRevenueUsd<=0)h+='<p class="warning">No paid Stripe revenue is recorded in this window. Use “Sync Stripe revenue” before treating modeled margin as collected cash.</p>';
  if((o.nonUsdRevenue||[]).length)h+='<p class="warning">Revenue in non-USD currencies is excluded from USD profitability: '+(o.nonUsdRevenue||[]).map(x=>currencyMoney(x.currency,Number(x.amountCents||0)/100)).map(esc).join(', ')+'.</p>';
  if(o.legacyCostUsd>0)h+='<p class="warning">Legacy runs contain '+money(o.legacyCostUsd)+' of aggregate spend without model attribution.</p>';
  if(o.failedRuns>0)h+='<p class="warning">'+o.failedRuns+' failed runs are included so provider spend cannot disappear from margin.</p>';
  if(o.actualProfitUsd<0)h+='<p class="negative">The selected window is contribution-negative. Review the client and model tables below before increasing capacity.</p>';
  if(o.actualRevenueUsd>0&&o.actualProfitUsd>=0&&o.legacyCostUsd===0)h+='<p class="positive">No contribution-loss or telemetry-gap alert is active for this window.</p>';
  h+='<p class="muted">Modeled active-plan contribution: <strong>'+money(o.modeledProfitUsd)+'</strong> · modeled margin <strong>'+pct(o.modeledMarginPct)+'</strong>. This is recurring-plan economics, not cash collected.</p><p class="muted">Fixed overhead: <strong>'+money(o.monthlyFixedCostUsd)+'/mo</strong> · allocated overhead: <strong>'+money(o.allocatedFixedCostUsd)+'</strong> · actual net profit: <strong class="'+marginClass(o.actualNetProfitUsd)+'">'+money(o.actualNetProfitUsd)+'</strong>.</p></div></div>';
  h+='<div class="split"><div class="panel"><div class="section-head"><strong>Daily cost per run</strong><span class="note">intensity of LLM spend</span></div><div class="trend">';
  for(const row of costPerRunSeries){h+='<div class="trend-row"><span class="mono">'+esc(String(row.day).slice(5))+'</span><div class="track" title="'+money(row.value)+' over '+row.runs+' run(s)"><div class="fill" style="width:'+Math.min(100,row.value/maxCostPerRun*100)+'%"></div></div><span class="right">'+money(row.value)+'</span></div>'}
  if(!costPerRunSeries.length)h+='<div class="empty">No daily spend yet.</div>';
  h+='</div></div><div class="panel"><div class="section-head"><strong>Calls by model</strong><span class="note">window total '+totalCalls+' · avg '+money(avgCall)+'/call</span></div><div class="trend">';
  for(const m of (d.byModel||[])){const calls=Number(m.calls||0);const perCall=calls?Number(m.costUsd||0)/calls:0;h+='<div class="trend-row"><span class="mono" title="'+esc(m.model)+'">'+esc(String(m.model).slice(0,14))+'</span><div class="track" title="'+calls+' calls · '+money(perCall)+'/call"><div class="fill" style="width:'+Math.min(100,calls/maxModelCalls*100)+'%"></div></div><span class="right">'+calls+' · '+money(perCall)+'</span></div>'}
  if(!(d.byModel||[]).length)h+='<div class="empty">No instrumented model calls yet.</div>';
  h+='</div></div></div>';
  h+='<h2>Fixed operating costs</h2><div class="panel"><div class="section-head"><strong>Monthly overhead inputs</strong><span class="note">server, monitoring, support, fees, and other fixed costs</span></div><form id="costForm" class="toolbar" style="margin-top:12px"><input name="category" placeholder="Category" required maxlength="80"><input name="amount" type="number" min="0" step="0.01" placeholder="USD / month" required><input name="note" placeholder="Note (optional)" maxlength="240" style="min-width:220px"><button type="submit">Save cost</button></form><div style="overflow:auto;margin-top:12px"><table><tr><th>Category</th><th class="num">Monthly amount</th><th>Note</th><th></th></tr>';
  for(const cost of (d.platformCosts||[])){h+='<tr><td>'+esc(cost.category)+'</td><td class="num">'+money(Number(cost.amountCents||0)/100)+'</td><td class="muted">'+esc(cost.note||'')+'</td><td class="right"><button class="secondary" data-delete-cost="'+esc(cost.category)+'" type="button">Remove</button></td></tr>'}
  if(!(d.platformCosts||[]).length)h+='<tr><td colspan="4" class="empty">Add monthly operating costs to see net profit after infrastructure overhead.</td></tr>';
  h+='</table></div></div>';
  h+='<h2>Model economics</h2><div class="panel"><table><tr><th>Model</th><th>Provider / tier</th><th class="num">Calls</th><th class="num">Runs</th><th class="num">Input</th><th class="num">Output</th><th class="num">Cost</th><th class="num">Avg / call</th><th class="num">Avg / run</th></tr>';
  for(const m of (d.byModel||[])){const calls=Number(m.calls||0);h+='<tr><td><strong>'+esc(m.model)+'</strong></td><td><span class="badge">'+esc(m.provider)+'</span> <span class="muted">'+esc(m.tier)+'</span></td><td class="num">'+calls+'</td><td class="num">'+m.runs+'</td><td class="num">'+tokens(m.inputTokens)+'</td><td class="num">'+tokens(m.outputTokens)+'</td><td class="num"><strong>'+money(m.costUsd)+'</strong></td><td class="num">'+money(calls?m.costUsd/calls:0)+'</td><td class="num">'+money(m.runs?m.costUsd/m.runs:0)+'</td></tr>'}
  if(!(d.byModel||[]).length)h+='<tr><td colspan="9" class="empty">No instrumented model usage exists in this range yet.</td></tr>';
  h+='</table></div>';
  h+='<h2>Client profitability</h2><div class="panel"><table><tr><th>Workspace</th><th>Plan</th><th class="num">Runs</th><th class="num">Actual revenue</th><th class="num">Modeled MRR</th><th class="num">COGS</th><th class="num">Profit</th><th class="num">Margin</th></tr>';
  for(const t of (d.byTenant||[])){const cls=marginClass(t.actualMarginPct);h+='<tr><td><strong>'+esc(t.name||t.slug)+'</strong><div class="mono">'+esc(t.slug)+'</div></td><td><span class="badge">'+esc(t.planLabel||t.plan)+'</span></td><td class="num">'+t.runs+'</td><td class="num">'+money(t.actualRevenueUsd)+'</td><td class="num">'+money(t.modeledMonthlyRevenueUsd)+'</td><td class="num">'+money(t.costUsd)+'</td><td class="num '+cls+'">'+money(t.actualProfitUsd)+'</td><td class="num '+cls+'">'+pct(t.actualMarginPct)+'</td></tr>'}
  if(!(d.byTenant||[]).length)h+='<tr><td colspan="8" class="empty">No client activity exists in this range.</td></tr>';
  h+='</table></div>';
  h+='<h2>Every review run · '+(d.recentRuns||[]).length+' loaded</h2><div class="panel">';
  for(const r of (d.recentRuns||[])){const cost=Number(r.actualCostUsd||0);h+='<details class="run"><summary><span><strong>#'+r.pr+' '+esc(r.repo)+'</strong><div class="run-meta">'+esc(r.owner)+' · '+esc(r.createdAt.slice(0,16).replace('T',' '))+'</div></span><span class="run-meta">'+esc(r.status)+'</span><span class="run-meta">'+(r.legacyCost?'legacy aggregate':'instrumented')+'</span><span class="run-cost">'+money(cost)+'</span></summary><div style="overflow:auto;margin-top:10px"><table><tr><th>Pass</th><th>Model</th><th>Provider / tier</th><th class="num">Input</th><th class="num">Output</th><th class="num">Cost</th><th>Source</th></tr>';
    if(r.usage&&r.usage.length){for(const u of r.usage){h+='<tr><td>'+esc(u.passName||'model call')+'</td><td><strong>'+esc(u.model)+'</strong></td><td>'+esc(u.provider)+' / '+esc(u.tier)+'</td><td class="num">'+tokens(u.inputTokens)+'</td><td class="num">'+tokens(u.outputTokens)+'</td><td class="num">'+money(u.costUsd)+'</td><td>'+esc(u.tokenSource)+'</td></tr>}}
    else h+='<tr><td colspan="7" class="empty">Legacy aggregate only; model-level attribution was not persisted for this run.</td></tr>';
    h+='</table></div></details>'}
  if(!(d.recentRuns||[]).length)h+='<div class="empty">No review runs exist in the selected window.</div>';
  h+='</div>';
  $('#costs').innerHTML=h;
  $('#costForm').onsubmit=async(e)=>{e.preventDefault();const f=new FormData(e.currentTarget);try{await api('/superadmin/api/operating-costs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({category:f.get('category'),amountCents:Math.round(Number(f.get('amount'))*100),note:f.get('note')})});await load()}catch(err){$('#status').textContent=err.message}};
  document.querySelectorAll('[data-delete-cost]').forEach((button)=>button.onclick=async()=>{try{await api('/superadmin/api/operating-costs/'+encodeURIComponent(button.dataset.deleteCost),{method:'DELETE'});await load()}catch(err){$('#status').textContent=err.message}});
}
function render(b){
  if(b.empty||!b.generatedAt){
    $('#content').innerHTML='<h2>Catch rate scoreboard</h2><div class="panel"><p class="warning">No scoreboard yet. Click <strong>Rebuild scoreboard</strong> once to mine GitHub PR comments (no LLM cost). Costs and live monitor above still work.</p><div class="toolbar" style="margin-top:10px"><label class="muted">Config-era snapshot</label><select id="scoreHistory" aria-label="Scoreboard history"><option value="">Current (empty)</option></select></div></div>';
    loadScoreHistory();
    return;
  }
  const bots=Object.entries(b.bots||{}).sort((x,y)=>y[1].clustersHit-x[1].clustersHit);
  let h='<h2>Catch rate · '+esc(b.repo)+' · '+b.prsAnalyzed+' PRs · '+(b.clusters?.total||0)+' defect clusters · rules '+esc(b.rulesHash||'?')+' · '+esc(b.generatedAt)+'</h2>';
  h+='<div class="panel toolbar" style="margin:0 0 10px"><label class="muted">Config-era snapshot</label><select id="scoreHistory" aria-label="Scoreboard history"><option value="">Current</option></select><span class="note muted">Compare rebuilds stamped with different rules hashes.</span></div>';
  if(b.trend){const t=b.trend;const d=t.recent.orvexCatchPct-t.older.orvexCatchPct;
    h+='<div class="panel">Trend — Orvex catch rate: recent half ('+t.recent.prs+' PRs) <strong>'+t.recent.orvexCatchPct+'%</strong> vs older half ('+t.older.prs+' PRs) <strong>'+t.older.orvexCatchPct+'%</strong> → <span class="'+(d>=0?'unique':'miss')+'">'+(d>=0?'+':'')+d+' pts</span>.</div>';}
  h+='<div class="panel"><table><tr><th>Bot</th><th>Findings</th><th>Clusters hit</th><th>Catch %</th><th>Unique catches</th><th>PRs w/ findings</th></tr>';
  for(const [name,s] of bots){h+='<tr><td><strong>'+esc(name)+'</strong></td><td>'+s.findings+'</td><td>'+s.clustersHit+'</td><td>'+(b.clusters.total?Math.round(100*s.clustersHit/b.clusters.total):0)+'%</td><td class="unique">'+s.uniqueClusters+'</td><td>'+s.prsWithFindings+'</td></tr>'}
  h+='</table></div>';
  h+='<h2 class="miss">Orvex missed ('+(b.clusters?.orvexMissed||[]).length+') — each is a candidate rule/lens</h2><div class="panel"><table><tr><th>PR</th><th>Location</th><th>Sev</th><th>Bots</th><th>Excerpt</th></tr>';
  for(const m of (b.clusters?.orvexMissed||[])){h+='<tr><td>#'+m.pr+'</td><td class="mono">'+esc(m.path||'?')+':'+(m.line??'?')+'</td><td>'+esc(m.severity||'—')+'</td><td>'+m.bots.map(esc).join(', ')+'</td><td class="mono">'+esc(m.excerpt)+'</td></tr>'}
  h+='</table></div>';
  h+='<h2 class="unique">Only Orvex caught ('+(b.clusters?.orvexUnique||[]).length+') — marketing ammo</h2><div class="panel"><table><tr><th>PR</th><th>Location</th><th>Sev</th><th>Excerpt</th></tr>';
  for(const m of (b.clusters?.orvexUnique||[])){h+='<tr><td>#'+m.pr+'</td><td class="mono">'+esc(m.path||'?')+':'+(m.line??'?')+'</td><td>'+esc(m.severity||'—')+'</td><td class="mono">'+esc(m.excerpt)+'</td></tr>'}
  h+='</table></div>';
  h+='<h2>Per-PR finding counts</h2><div class="panel"><table><tr><th>PR</th><th>Title</th><th>State</th><th>Counts</th></tr>';
  for(const p of (b.perPr||[])){const c=Object.entries(p.counts||{}).map(([k,v])=>k+':'+v).join('  ')||'—';h+='<tr><td>#'+p.pr+'</td><td>'+esc(String(p.title||'').slice(0,70))+'</td><td>'+esc(p.state)+'</td><td class="mono">'+esc(c)+'</td></tr>'}
  h+='</table></div>';
  $('#content').innerHTML=h;
  loadScoreHistory();
}
async function loadScoreHistory(){
  const sel=$('#scoreHistory'); if(!sel)return;
  try{
    const data=await api('/superadmin/api/scoreboard/history');
    const current=sel.value;
    sel.innerHTML='<option value="">Current</option>';
    for(const s of (data.snapshots||[])){
      const label=(s.at||s.file)+' · rules '+(s.rulesHash||'?');
      const opt=document.createElement('option');
      opt.value=s.file; opt.textContent=label;
      sel.appendChild(opt);
    }
    if(current) sel.value=current;
    sel.onchange=async()=>{
      if(!sel.value){const cur=await api('/superadmin/api/scoreboard');render(cur);return;}
      try{render(await api('/superadmin/api/scoreboard/history/'+encodeURIComponent(sel.value)))}
      catch(e){$('#status').textContent=e.message}
    };
  }catch(e){/* history is optional */}
}
function renderDeep(d){
  let h='<h2>Deep vs Normal · '+d.totals.normalRuns+' normal / '+d.totals.deepRuns+' deep runs · '+esc(d.generatedAt)+'</h2>';
  h+='<div class="panel"><table><tr><th></th><th>Avg cost</th><th>Avg duration</th><th>Avg new findings/run</th></tr>';
  h+='<tr><td><strong>Normal</strong></td><td>$'+d.totals.avgCostNormal.toFixed(3)+'</td><td>'+Math.round(d.totals.avgDurationSNormal)+'s</td><td>'+d.totals.avgNewFindingsNormal.toFixed(1)+'</td></tr>';
  h+='<tr><td><strong>Deep</strong></td><td>$'+d.totals.avgCostDeep.toFixed(3)+'</td><td>'+Math.round(d.totals.avgDurationSDeep)+'s</td><td>'+d.totals.avgNewFindingsDeep.toFixed(1)+'</td></tr></table></div>';
  h+='<div class="panel">A/B pairs (normal first, then deep, same commit): <strong>'+d.pairs.length+'</strong> · deep added a P1/P2 beyond normal on <strong class="'+(d.pairs.length&&d.pairsWhereDeepAddedSevere/d.pairs.length>=0.5?'unique':'miss')+'">'+d.pairsWhereDeepAddedSevere+' / '+d.pairs.length+'</strong> pairs · unpaired deep runs (no prior normal, not marginal): '+d.unpairedDeepRuns+'</div>';
  if(d.pairs.length){h+='<div class="panel"><table><tr><th>PR@commit</th><th>Normal found (P1/P2/P3/info)</th><th>Deep ADDED (P1/P2/P3/info)</th><th>Normal $</th><th>Deep $</th></tr>';
    const f=(x)=>x.P1+'/'+x.P2+'/'+x.P3+'/'+x.info;
    for(const p of d.pairs){h+='<tr><td class="mono">#'+p.pr+'@'+esc(p.headSha.slice(0,7))+'</td><td>'+f(p.normal.found)+'</td><td class="'+((p.deepMarginal.found.P1+p.deepMarginal.found.P2)>0?'unique':'')+'">'+f(p.deepMarginal.found)+'</td><td>$'+p.normal.costUsd.toFixed(3)+'</td><td>$'+p.deepMarginal.costUsd.toFixed(3)+'</td></tr>'}
    h+='</table></div>';}
  $('#deep').innerHTML=h;
}
async function loadLive(){try{renderLive(await api('/superadmin/api/active-reviews'))}catch(e){if($('#live'))$('#live').innerHTML='<div class="panel warning">Live monitor unavailable: '+esc(e.message)+'</div>'}}
async function load(){ $('#status').textContent='loading…';const days=$('#range').value;try{await loadLive();renderCosts(await api('/superadmin/api/costs?days='+encodeURIComponent(days)+'&limit=5000'));render(await api('/superadmin/api/scoreboard'));renderDeep(await api('/superadmin/api/deep-scorecard'));$('#status').textContent=''}catch(e){$('#status').textContent=e.message} }
$('#rebuild').onclick=async()=>{$('#rebuild').disabled=true;$('#status').textContent='rebuilding — reading PR comments from GitHub…';try{render(await api('/superadmin/api/scoreboard/rebuild?prs=80',{method:'POST'}));$('#status').textContent='rebuilt ✓'}catch(e){$('#status').textContent=e.message}finally{$('#rebuild').disabled=false}};
$('#refresh').onclick=load;
$('#range').onchange=load;
$('#syncRevenue').onclick=async()=>{$('#syncRevenue').disabled=true;$('#status').textContent='syncing Stripe invoices…';try{const result=await api('/superadmin/api/revenue/sync',{method:'POST'});$('#status').textContent='Stripe synced '+result.synced+' invoice(s)'+(result.errors.length?' · '+result.errors.length+' error(s)':'');await load()}catch(e){$('#status').textContent=e.message}finally{$('#syncRevenue').disabled=false}};
$('#security').onclick=()=>{location.href='/settings/security'};
load();
setInterval(loadLive,3000);
</script>
</main></body></html>`;
