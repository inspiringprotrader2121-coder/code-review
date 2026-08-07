import { Hono, type Context } from 'hono';
import { listInstallationRepos, loadGitHubConfigFromEnv } from '@orvex-review/github';
import { createAppDatabase, type Tenant } from '@orvex-review/store';
import {
  TenantService,
  WorkspaceAccessError,
  authDisabled,
  legacyAuthMode,
} from '@orvex-review/tenants';
import { sessionUser } from './session.js';
import { checkRateLimit } from './rate-limit.js';
import { llmCostVisibleForTenant, reviewRunsForTenant, workspaceStatsForTenant } from './cost-visibility.js';
import { sameOriginRequest } from './request-security.js';


export function apiRoutes() {
  const app = new Hono();
  const db = createAppDatabase();
  const tenants = new TenantService(db);

  /** Resolve the membership-checked tenant, or (in legacy no-login mode) any tenant by slug. */
  function workspace(c: Context): { tenant: Tenant; role: 'owner' | 'member' } | Response {
    const slug = c.req.param('slug');
    if (!slug) return c.json({ error: 'workspace slug required' }, 400);

    // Legacy mode (no OAuth configured): allow read access by slug so the
    // dashboard works before login is set up. Locks down once OAuth is on.
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
      if (err instanceof WorkspaceAccessError) {
        return c.json({ error: err.message }, err.status);
      }
      throw err;
    }
  }

  function mutationRequestAllowed(c: Context): boolean {
    return authDisabled() || legacyAuthMode(db.hasPasswordUsers()) || sameOriginRequest(c);
  }

  app.get('/api/workspaces/:slug/stats', (c) => {
    const ws = workspace(c);
    if (ws instanceof Response) return ws;
    const days = clamp(Number(c.req.query('days') ?? 14), 1, 365);
    const canViewLlmCost = llmCostVisibleForTenant(ws.tenant.slug);
    return c.json({
      workspace: ws.tenant.slug,
      ...workspaceStatsForTenant(db.getWorkspaceStats(ws.tenant.id, days), canViewLlmCost),
    });
  });

  app.get('/api/workspaces/:slug/reviews', (c) => {
    const ws = workspace(c);
    if (ws instanceof Response) return ws;
    const limit = clamp(Number(c.req.query('limit') ?? 50), 1, 200);
    const canViewLlmCost = llmCostVisibleForTenant(ws.tenant.slug);
    return c.json({
      workspace: ws.tenant.slug,
      reviews: reviewRunsForTenant(db.listReviewRuns(ws.tenant.id, limit), canViewLlmCost),
    });
  });

  app.get('/api/workspaces/:slug/installations', (c) => {
    const ws = workspace(c);
    if (ws instanceof Response) return ws;
    return c.json({
      workspace: ws.tenant.slug,
      installations: db.getInstallationsForTenant(ws.tenant.id).map((i) => ({
        installationId: i.installationId,
        account: i.accountLogin,
        accountType: i.accountType,
        repositorySelection: i.repositorySelection,
        suspended: Boolean(i.suspendedAt),
        updatedAt: i.updatedAt,
      })),
    });
  });

  // ——— Repositories: list + enable/disable + per-repo settings ———

  app.get('/api/workspaces/:slug/repos', (c) => {
    const ws = workspace(c);
    if (ws instanceof Response) return ws;
    return c.json({ workspace: ws.tenant.slug, repos: db.listRepos(ws.tenant.id) });
  });

  // Pull the accessible repo list from GitHub and upsert it — backfills repos
  // for installations created before repo tracking, and refreshes on demand.
  app.post('/api/workspaces/:slug/repos/sync', async (c) => {
    const ws = workspace(c);
    if (ws instanceof Response) return ws;
    if (!mutationRequestAllowed(c)) return c.json({ error: 'same-origin request required' }, 403);
    if (ws.role !== 'owner') return c.json({ error: 'only a workspace owner can sync repositories' }, 403);
    // This is the one expensive endpoint here — it fans out a live GitHub API call
    // per installation. Throttle per tenant so it can't be hammered to exhaust the
    // App's REST rate limit / spike DB writes.
    const limit = checkRateLimit(`repos-sync:${ws.tenant.id}`, { windowMs: 60_000, max: 3 });
    if (!limit.allowed) {
      c.header('Retry-After', String(limit.retryAfterSeconds));
      return c.json({ error: 'rate limited — try again shortly' }, 429);
    }
    const cfg = loadGitHubConfigFromEnv();
    const settings = db.getWorkspaceSettings(ws.tenant.id);
    let synced = 0;
    for (const inst of db.getInstallationsForTenant(ws.tenant.id)) {
      if (inst.suspendedAt) continue;
      try {
        const repos = await listInstallationRepos(cfg, inst.installationId);
        for (const r of repos) {
          db.upsertRepo({
            installationId: inst.installationId,
            tenantId: ws.tenant.id,
            githubRepoId: r.githubRepoId,
            owner: r.owner,
            name: r.name,
            fullName: r.fullName,
            private: r.private,
            defaultBranch: r.defaultBranch,
            enabled: settings.autoEnableNewRepos,
          });
          synced += 1;
        }
      } catch (err) {
        console.warn(`[api] repo sync failed for installation ${inst.installationId}:`, err);
      }
    }
    return c.json({ ok: true, synced, repos: db.listRepos(ws.tenant.id) });
  });

  app.patch('/api/workspaces/:slug/repos/:repoId', async (c) => {
    const ws = workspace(c);
    if (ws instanceof Response) return ws;
    if (!mutationRequestAllowed(c)) return c.json({ error: 'same-origin request required' }, 403);
    if (ws.role !== 'owner') return c.json({ error: 'only a workspace owner can change repository settings' }, 403);
    const repoId = c.req.param('repoId');
    const repo = db.listRepos(ws.tenant.id).find((r) => r.id === repoId);
    if (!repo) return c.json({ error: 'repo not found in this workspace' }, 404);

    const body: {
      enabled?: boolean;
      reviewMode?: 'normal' | 'strict';
      autoApply?: boolean;
      reviewOnOpen?: boolean;
      reviewOnPush?: boolean;
    } = await c.req.json().catch(() => ({}));

    if (typeof body.enabled === 'boolean') db.setRepoEnabled(repoId, body.enabled);
    if (
      body.reviewMode ||
      typeof body.autoApply === 'boolean' ||
      typeof body.reviewOnOpen === 'boolean' ||
      typeof body.reviewOnPush === 'boolean'
    ) {
      db.updateRepoSettings(repoId, {
        reviewMode: body.reviewMode,
        autoApply: body.autoApply,
        reviewOnOpen: body.reviewOnOpen,
        reviewOnPush: body.reviewOnPush,
      });
    }
    const updated = db.listRepos(ws.tenant.id).find((r) => r.id === repoId);
    return c.json({ ok: true, repo: updated });
  });

  // ——— Pull requests: lifecycle list + counts ———

  app.get('/api/workspaces/:slug/pulls', (c) => {
    const ws = workspace(c);
    if (ws instanceof Response) return ws;
    const stateParam = c.req.query('state');
    const state =
      stateParam === 'open' || stateParam === 'merged' || stateParam === 'closed'
        ? stateParam
        : undefined;
    const limit = clamp(Number(c.req.query('limit') ?? 100), 1, 300);
    return c.json({
      workspace: ws.tenant.slug,
      counts: db.getPullRequestCounts(ws.tenant.id),
      pulls: db.listPullRequests(ws.tenant.id, { state, limit }),
    });
  });

  // ——— Findings (bugs): list + counts, filter by status/repo ———

  app.get('/api/workspaces/:slug/findings', (c) => {
    const ws = workspace(c);
    if (ws instanceof Response) return ws;
    const statusParam = c.req.query('status');
    const status =
      statusParam === 'open' || statusParam === 'fixed' || statusParam === 'ignored'
        ? statusParam
        : undefined;
    const limit = clamp(Number(c.req.query('limit') ?? 200), 1, 500);
    return c.json({
      workspace: ws.tenant.slug,
      counts: db.getFindingCounts(ws.tenant.id),
      findings: db.listFindings(ws.tenant.id, {
        status,
        repoFullName: c.req.query('repo') ?? undefined,
        limit,
      }),
    });
  });

  // ——— Workspace settings ———

  app.get('/api/workspaces/:slug/settings', (c) => {
    const ws = workspace(c);
    if (ws instanceof Response) return ws;
    return c.json({ workspace: ws.tenant.slug, settings: db.getWorkspaceSettings(ws.tenant.id) });
  });

  app.put('/api/workspaces/:slug/settings', async (c) => {
    const ws = workspace(c);
    if (ws instanceof Response) return ws;
    if (!mutationRequestAllowed(c)) return c.json({ error: 'same-origin request required' }, 403);
    if (ws.role !== 'owner') return c.json({ error: 'only a workspace owner can change workspace settings' }, 403);
    const body: {
      defaultReviewMode?: 'normal' | 'strict';
      autoApplyDefault?: boolean;
      maxComments?: number;
      autoEnableNewRepos?: boolean;
    } = await c.req.json().catch(() => ({}));

    const patch: Record<string, unknown> = {};
    if (body.defaultReviewMode) patch.defaultReviewMode = body.defaultReviewMode;
    if (typeof body.autoApplyDefault === 'boolean') patch.autoApplyDefault = body.autoApplyDefault;
    if (typeof body.maxComments === 'number') patch.maxComments = clamp(body.maxComments, 1, 50);
    if (typeof body.autoEnableNewRepos === 'boolean') patch.autoEnableNewRepos = body.autoEnableNewRepos;

    return c.json({ ok: true, settings: db.updateWorkspaceSettings(ws.tenant.id, patch) });
  });

  // ——— Dashboard summary: everything the overview needs in one call ———

  app.get('/api/workspaces/:slug/overview', (c) => {
    const ws = workspace(c);
    if (ws instanceof Response) return ws;
    const t = ws.tenant.id;
    const canViewLlmCost = llmCostVisibleForTenant(ws.tenant.slug);
    return c.json({
      workspace: ws.tenant.slug,
      stats: workspaceStatsForTenant(db.getWorkspaceStats(t, 14), canViewLlmCost),
      pullRequests: db.getPullRequestCounts(t),
      findings: db.getFindingCounts(t),
      repos: db.listRepos(t).map((r) => ({ fullName: r.fullName, enabled: r.enabled })),
      recentReviews: reviewRunsForTenant(db.listReviewRuns(t, 8), canViewLlmCost),
    });
  });

  return app;
}

function clamp(n: number, min: number, max: number): number {
  if (Number.isNaN(n)) return min;
  return Math.min(max, Math.max(min, n));
}
