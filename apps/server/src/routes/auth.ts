import { Hono } from 'hono';
import { loadGitHubConfigFromEnv } from '@velatrix-review/github';
import {
  TenantService,
  appPublicUrl,
  verifyInstallState,
  platformSecret,
} from '@velatrix-review/tenants';

export function authRoutes() {
  const app = new Hono();
  const tenants = new TenantService();

  app.get('/connect', (c) => {
    return c.html(`<!DOCTYPE html>
<html><head><title>Velatrix Review — Connect GitHub</title>
<style>
  body { font-family: system-ui; max-width: 520px; margin: 4rem auto; padding: 0 1rem; }
  input, button { font-size: 1rem; padding: 0.5rem; }
  input { width: 100%; margin: 0.5rem 0 1rem; box-sizing: border-box; }
  button { background: #24292f; color: #fff; border: 0; border-radius: 6px; cursor: pointer; width: 100%; }
  p.muted { color: #57606a; font-size: 0.9rem; }
</style></head>
<body>
  <h1>Connect GitHub</h1>
  <p>Install the Velatrix Review GitHub App on your org or account. Each customer gets an isolated workspace.</p>
  <form method="get" action="/auth/github/install">
    <label for="tenant">Workspace slug (e.g. <code>acme</code>)</label>
    <input id="tenant" name="tenant" required pattern="[a-zA-Z0-9-]+" placeholder="acme" />
    <label for="name">Display name (optional)</label>
    <input id="name" name="name" placeholder="Acme Corp" />
    <button type="submit">Continue to GitHub →</button>
  </form>
  <p class="muted">You'll choose which repositories the app can access on GitHub.</p>
</body></html>`);
  });

  app.get('/auth/github/install', (c) => {
    const tenantSlug = c.req.query('tenant');
    const name = c.req.query('name') ?? undefined;
    if (!tenantSlug) {
      return c.redirect('/connect');
    }

    const { installUrl } = tenants.startConnect(tenantSlug, name);
    return c.redirect(installUrl);
  });

  app.get('/auth/github/callback', async (c) => {
    const installationId = Number(c.req.query('installation_id'));
    const setupAction = c.req.query('setup_action');
    const state = c.req.query('state');

    if (!installationId || Number.isNaN(installationId)) {
      return c.json({ error: 'missing installation_id' }, 400);
    }

    let tenantSlug = 'default';
    if (state) {
      const payload = verifyInstallState(state, platformSecret());
      if (!payload) {
        return c.json({ error: 'invalid or expired state' }, 400);
      }
      tenantSlug = payload.tenantSlug;
    }

    try {
      const { tenant, installation } = await tenants.completeInstallCallback(
        installationId,
        tenantSlug,
        loadGitHubConfigFromEnv(),
      );

      return c.html(`<!DOCTYPE html>
<html><head><title>GitHub connected</title>
<style>body{font-family:system-ui;max-width:520px;margin:4rem auto;padding:0 1rem}</style></head>
<body>
  <h1>GitHub connected</h1>
  <p>Workspace <strong>${tenant.slug}</strong> is linked to
     <strong>${installation.accountLogin}</strong> (${installation.accountType}).</p>
  <p>Setup action: <code>${setupAction ?? 'install'}</code></p>
  <p>Installation ID: <code>${installation.installationId}</code></p>
  <p>Open a PR on a connected repo — Velatrix Review will comment automatically.</p>
  <p><a href="/api/tenants/${tenant.slug}">View status (JSON)</a></p>
</body></html>`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  app.get('/api/tenants/:slug', (c) => {
    const status = tenants.getTenantStatus(c.req.param('slug'));
    if (!status) return c.json({ error: 'tenant not found' }, 404);
    return c.json({
      tenant: status.tenant,
      installations: status.installations.map((i) => ({
        installationId: i.installationId,
        account: i.accountLogin,
        accountType: i.accountType,
        repositorySelection: i.repositorySelection,
        suspended: Boolean(i.suspendedAt),
        updatedAt: i.updatedAt,
      })),
      appUrl: appPublicUrl(),
    });
  });

  return app;
}
