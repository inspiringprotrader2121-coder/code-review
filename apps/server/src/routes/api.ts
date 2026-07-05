import { Hono, type Context } from 'hono';
import { listInstallationRepos, loadGitHubConfigFromEnv } from '@orvex-review/github';
import { createAppDatabase, type Tenant } from '@orvex-review/store';
import {
  TenantService,
  WorkspaceAccessError,
  legacyAuthMode,
} from '@orvex-review/tenants';
import { sessionUser } from './session.js';


export function apiRoutes() {
  const app = new Hono();
  const db = createAppDatabase();
  const tenants = new TenantService(db);

  /** Resolve the membership-checked tenant, or (in legacy no-login mode) any tenant by slug. */
  function workspace(c: Context): { tenant: Tenant } | Response {
    const slug = c.req.param('slug');
    if (!slug) return c.json({ error: 'workspace slug required' }, 400);

    // Legacy mode (no OAuth configured): allow read access by slug so the
    // dashboard works before login is set up. Locks down once OAuth is on.
    if (legacyAuthMode()) {
      const tenant = db.getTenantBySlug(slug);
      if (!tenant) return c.json({ error: 'workspace not found' }, 404);
      return { tenant };
    }

    const user = sessionUser(c, db);
    if (!user) return c.json({ error: 'not signed in' }, 401);
    try {
      const { tenant } = tenants.getTenantStatusForUser(slug, user.id);
      return { tenant };
    } catch (err) {
      if (err instanceof WorkspaceAccessError) {
        return c.json({ error: err.message }, err.status);
      }
      throw err;
    }
  }

  app.get('/api/workspaces/:slug/stats', (c) => {
    const ws = workspace(c);
    if (ws instanceof Response) return ws;
    const days = clamp(Number(c.req.query('days') ?? 14), 1, 365);
    return c.json({ workspace: ws.tenant.slug, ...db.getWorkspaceStats(ws.tenant.id, days) });
  });

  app.get('/api/workspaces/:slug/reviews', (c) => {
    const ws = workspace(c);
    if (ws instanceof Response) return ws;
    const limit = clamp(Number(c.req.query('limit') ?? 50), 1, 200);
    return c.json({ workspace: ws.tenant.slug, reviews: db.listReviewRuns(ws.tenant.id, limit) });
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
    const body: {
      defaultReviewMode?: 'normal' | 'strict';
      autoApplyDefault?: boolean;
      minConfidence?: number;
      maxComments?: number;
      autoEnableNewRepos?: boolean;
    } = await c.req.json().catch(() => ({}));

    const patch: Record<string, unknown> = {};
    if (body.defaultReviewMode) patch.defaultReviewMode = body.defaultReviewMode;
    if (typeof body.autoApplyDefault === 'boolean') patch.autoApplyDefault = body.autoApplyDefault;
    if (typeof body.minConfidence === 'number') patch.minConfidence = clamp(body.minConfidence, 0, 1);
    if (typeof body.maxComments === 'number') patch.maxComments = clamp(body.maxComments, 1, 50);
    if (typeof body.autoEnableNewRepos === 'boolean') patch.autoEnableNewRepos = body.autoEnableNewRepos;

    return c.json({ ok: true, settings: db.updateWorkspaceSettings(ws.tenant.id, patch) });
  });

  // ——— Dashboard summary: everything the overview needs in one call ———

  app.get('/api/workspaces/:slug/overview', (c) => {
    const ws = workspace(c);
    if (ws instanceof Response) return ws;
    const t = ws.tenant.id;
    return c.json({
      workspace: ws.tenant.slug,
      stats: db.getWorkspaceStats(t, 14),
      pullRequests: db.getPullRequestCounts(t),
      findings: db.getFindingCounts(t),
      repos: db.listRepos(t).map((r) => ({ fullName: r.fullName, enabled: r.enabled })),
      recentReviews: db.listReviewRuns(t, 8),
    });
  });

  return app;
}

function clamp(n: number, min: number, max: number): number {
  if (Number.isNaN(n)) return min;
  return Math.min(max, Math.max(min, n));
}
