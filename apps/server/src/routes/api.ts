import { Hono, type Context } from 'hono';
import type { GitHubAppConfig } from '@orvex-review/github';
import type { IdentityRepository, Tenant, TenancyRepository } from '@orvex-review/store';
import { sameOriginRequest } from './request-security.js';
import { AuthorizationService } from '../application/identity/authorization.js';
import type { ServerConfig } from '../bootstrap/config.js';
import {
  WorkspaceApiService,
  type RepoPatch,
  type WorkspaceApiStore,
  type WorkspaceSettingsPatch,
} from '../application/workspace/workspace-api-service.js';

export interface ApiRouteDependencies {
  db: WorkspaceApiStore &
    Pick<TenancyRepository, 'getMembership' | 'getTenantBySlug'> &
    Pick<IdentityRepository, 'getSessionUser' | 'hasPasswordUsers' | 'upsertUserFromGitHub'>;
  config: Pick<
    ServerConfig,
    | 'appUrl'
    | 'authDisabled'
    | 'costVisibilityTenants'
    | 'oauth'
    | 'platformSecret'
    | 'requireLogin'
  >;
  githubConfig?: GitHubAppConfig;
}

export function apiRoutes(dependencies: ApiRouteDependencies) {
  const { db, config } = dependencies;
  const app = new Hono();
  const authorization = new AuthorizationService(db, config);
  const workspaceApi = new WorkspaceApiService(db, {
    costVisibilityTenants: config.costVisibilityTenants,
    githubConfig: dependencies.githubConfig,
  });

  /** Resolve the membership-checked tenant, or (in legacy no-login mode) any tenant by slug. */
  function workspace(c: Context): { tenant: Tenant; role: 'owner' | 'member' } | Response {
    const slug = c.req.param('slug');
    if (!slug) return c.json({ error: 'workspace slug required' }, 400);

    const decision = authorization.workspace(c, slug);
    if ('status' in decision) {
      const message =
        decision.code === 'not_signed_in'
          ? 'not signed in'
          : decision.code === 'workspace_not_found'
            ? 'workspace not found'
            : 'not a member of this workspace';
      return c.json({ error: message }, decision.status);
    }
    return { tenant: decision.tenant, role: decision.role };
  }

  function mutationRequestAllowed(c: Context): boolean {
    return (
      config.authDisabled ||
      apiLegacyAuthMode(db.hasPasswordUsers(), config) ||
      sameOriginRequest(c, config)
    );
  }

  app.get('/api/workspaces/:slug/stats', (c) => {
    const ws = workspace(c);
    if (ws instanceof Response) return ws;
    return c.json({
      workspace: ws.tenant.slug,
      ...workspaceApi.stats(ws.tenant, Number(c.req.query('days') ?? 14)),
    });
  });

  app.get('/api/workspaces/:slug/reviews', (c) => {
    const ws = workspace(c);
    if (ws instanceof Response) return ws;
    return c.json({
      workspace: ws.tenant.slug,
      reviews: workspaceApi.reviews(ws.tenant, Number(c.req.query('limit') ?? 50)),
    });
  });

  app.get('/api/workspaces/:slug/installations', (c) => {
    const ws = workspace(c);
    if (ws instanceof Response) return ws;
    return c.json({
      workspace: ws.tenant.slug,
      installations: workspaceApi.installations(ws.tenant),
    });
  });

  // ——— Repositories: list + enable/disable + per-repo settings ———

  app.get('/api/workspaces/:slug/repos', (c) => {
    const ws = workspace(c);
    if (ws instanceof Response) return ws;
    return c.json({ workspace: ws.tenant.slug, repos: workspaceApi.repos(ws.tenant) });
  });

  // Pull the accessible repo list from GitHub and upsert it — backfills repos
  // for installations created before repo tracking, and refreshes on demand.
  app.post('/api/workspaces/:slug/repos/sync', async (c) => {
    const ws = workspace(c);
    if (ws instanceof Response) return ws;
    if (!mutationRequestAllowed(c)) return c.json({ error: 'same-origin request required' }, 403);
    if (ws.role !== 'owner')
      return c.json({ error: 'only a workspace owner can sync repositories' }, 403);
    const result = await workspaceApi.syncRepos(ws.tenant);
    if (result.kind === 'rate_limited') {
      c.header('Retry-After', String(result.retryAfterSeconds));
      return c.json({ error: 'rate limited — try again shortly' }, 429);
    }
    if (result.kind === 'unavailable')
      return c.json({ error: 'GitHub App is not configured' }, 501);
    return c.json({ ok: true, synced: result.synced, repos: result.repos });
  });

  app.patch('/api/workspaces/:slug/repos/:repoId', async (c) => {
    const ws = workspace(c);
    if (ws instanceof Response) return ws;
    if (!mutationRequestAllowed(c)) return c.json({ error: 'same-origin request required' }, 403);
    if (ws.role !== 'owner')
      return c.json({ error: 'only a workspace owner can change repository settings' }, 403);
    const repoId = c.req.param('repoId');
    const body = await c.req.json<RepoPatch>().catch(() => ({}));
    const updated = workspaceApi.updateRepo(ws.tenant, repoId, body);
    if (!updated) return c.json({ error: 'repo not found in this workspace' }, 404);
    return c.json({ ok: true, repo: updated });
  });

  // ——— Pull requests: lifecycle list + counts ———

  app.get('/api/workspaces/:slug/pulls', (c) => {
    const ws = workspace(c);
    if (ws instanceof Response) return ws;
    return c.json({
      workspace: ws.tenant.slug,
      ...workspaceApi.pulls(ws.tenant, c.req.query('state'), Number(c.req.query('limit') ?? 100)),
    });
  });

  // ——— Findings (bugs): list + counts, filter by status/repo ———

  app.get('/api/workspaces/:slug/findings', (c) => {
    const ws = workspace(c);
    if (ws instanceof Response) return ws;
    return c.json({
      workspace: ws.tenant.slug,
      ...workspaceApi.findings(
        ws.tenant,
        c.req.query('status'),
        c.req.query('repo') ?? undefined,
        Number(c.req.query('limit') ?? 200),
      ),
    });
  });

  // ——— Workspace settings ———

  app.get('/api/workspaces/:slug/settings', (c) => {
    const ws = workspace(c);
    if (ws instanceof Response) return ws;
    return c.json({ workspace: ws.tenant.slug, settings: workspaceApi.settings(ws.tenant) });
  });

  app.put('/api/workspaces/:slug/settings', async (c) => {
    const ws = workspace(c);
    if (ws instanceof Response) return ws;
    if (!mutationRequestAllowed(c)) return c.json({ error: 'same-origin request required' }, 403);
    if (ws.role !== 'owner')
      return c.json({ error: 'only a workspace owner can change workspace settings' }, 403);
    const body = await c.req.json<WorkspaceSettingsPatch>().catch(() => ({}));
    return c.json({ ok: true, settings: workspaceApi.updateSettings(ws.tenant, body) });
  });

  // ——— Dashboard summary: everything the overview needs in one call ———

  app.get('/api/workspaces/:slug/overview', (c) => {
    const ws = workspace(c);
    if (ws instanceof Response) return ws;
    return c.json({
      workspace: ws.tenant.slug,
      ...workspaceApi.overview(ws.tenant),
    });
  });

  return app;
}

function apiLegacyAuthMode(
  hasPasswordUsers: boolean,
  config: Pick<ServerConfig, 'authDisabled' | 'oauth' | 'requireLogin'>,
): boolean {
  return (
    !config.requireLogin &&
    !hasPasswordUsers &&
    !config.oauth.github &&
    !config.oauth.google &&
    !config.authDisabled
  );
}
