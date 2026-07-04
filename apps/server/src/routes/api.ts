import { Hono, type Context } from 'hono';
import { createAppDatabase, type Tenant } from '@orvex-review/store';
import { TenantService, WorkspaceAccessError } from '@orvex-review/tenants';
import { sessionUser } from './session.js';

export function apiRoutes() {
  const app = new Hono();
  const db = createAppDatabase();
  const tenants = new TenantService(db);

  /** Resolve authenticated user + membership-checked tenant, or an error response. */
  function workspace(c: Context): { tenant: Tenant } | Response {
    const user = sessionUser(c, db);
    if (!user) return c.json({ error: 'not signed in' }, 401);
    const slug = c.req.param('slug');
    if (!slug) return c.json({ error: 'workspace slug required' }, 400);
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

  return app;
}

function clamp(n: number, min: number, max: number): number {
  if (Number.isNaN(n)) return min;
  return Math.min(max, Math.max(min, n));
}
