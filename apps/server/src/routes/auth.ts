import { Hono } from 'hono';
import { loadGitHubConfigFromEnv } from '@velatrix-review/github';
import {
  TenantService,
  appPublicUrl,
  verifyInstallState,
  signInstallState,
  platformSecret,
} from '@velatrix-review/tenants';

export function authRoutes() {
  const app = new Hono();
  const tenants = new TenantService();

  function escapeHtml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  app.get('/dashboard', (c) => {
    const appUrl = appPublicUrl();
    return c.html(`<!DOCTYPE html>
<html><head><title>Velatrix Review Dashboard</title>
<style>
  body { font-family: system-ui; max-width: 760px; margin: 4rem auto; padding: 0 1rem; }
  section { border: 1px solid #d0d7de; border-radius: 10px; margin: 1rem 0; padding: 1rem; }
  input, button { font-size: 1rem; padding: 0.5rem; }
  input { width: 100%; margin: 0.5rem 0 1rem; box-sizing: border-box; }
  button { background: #24292f; color: #fff; border: 0; border-radius: 6px; cursor: pointer; width: 100%; }
  button.secondary { background: #57606a; margin-top: 0.5rem; }
  p.muted { color: #57606a; font-size: 0.9rem; }
  pre { background: #f6f8fa; padding: 0.75rem; border-radius: 8px; overflow: auto; }
</style></head>
<body>
  <h1>Velatrix Review Dashboard</h1>
  <p class="muted">Open this dashboard, connect your GitHub App, then check tenant status.</p>

  <section>
    <h2>1) Connect GitHub App</h2>
    <p>Use your workspace slug so all repos stay isolated per tenant.</p>
    <form method="get" action="/connect">
      <label for="tenant">Workspace slug</label>
      <input id="tenant" name="tenant" required pattern="[a-zA-Z0-9-]+" placeholder="acme" />
      <label for="name">Display name (optional)</label>
      <input id="name" name="name" placeholder="Acme Corp" />
      <button type="submit">Start trial / choose plan</button>
    </form>
    <p class="muted">The connect step starts Orvex onboarding before GitHub installation is unlocked. Service URL: <code>${appUrl}</code>.</p>
  </section>

  <section>
    <h2>2) Tenant status</h2>
    <form id="tenant-status-form">
      <label for="tenant-status">Workspace slug</label>
      <input id="tenant-status" name="tenant" placeholder="acme" required pattern="[a-zA-Z0-9-]+" />
      <button type="button" class="secondary" id="load-status">Load status</button>
    </form>
    <pre id="tenant-status-output">Enter a workspace slug and click <strong>Load status</strong>.</pre>
  </section>

  <section>
    <h2>Manual command path</h2>
    <p>In a PR comment, trigger review with:</p>
    <ul>
      <li><code>/review</code></li>
      <li><code>/velatrix-review</code></li>
      <li><code>@velatrix-review review</code> (or <code>@minimax review</code>)</li>
    </ul>
  </section>

  <script>
    const output = document.getElementById('tenant-status-output');
    document.getElementById('load-status').addEventListener('click', async () => {
      const tenant = document.getElementById('tenant-status').value.trim();
      if (!tenant) return;
      output.textContent = 'Loading...';
      try {
        const response = await fetch('/api/tenants/' + encodeURIComponent(tenant));
        const data = await response.json();
        output.textContent = JSON.stringify(data, null, 2);
      } catch (err) {
        output.textContent = 'Failed to load status: ' + String(err);
      }
    });
  </script>
</body></html>`);
  });

  app.get('/connect', (c) => {
    const tenant = c.req.query('tenant') ?? '';
    const name = c.req.query('name') ?? '';
    const email = c.req.query('email') ?? '';
    return c.html(`<!DOCTYPE html>
<html><head><title>Orvex Review — Create account</title>
<style>
  body { font-family: ui-sans-serif, system-ui, sans-serif; max-width: 960px; margin: 4rem auto; padding: 0 1rem; color: #171713; background: radial-gradient(circle at top left, #fff7d8, #f7f5ed 38%, #ece8d6); }
  .layout { display: grid; grid-template-columns: 1.05fr 0.95fr; gap: 1rem; align-items: stretch; }
  section, .plan, .aside { border: 1px solid #d9dccf; border-radius: 16px; padding: 1.1rem; background: rgba(255, 253, 247, 0.92); box-shadow: 0 18px 50px rgba(48, 57, 40, 0.08); }
  input, button { font-size: 1rem; padding: 0.72rem; }
  input { width: 100%; margin: 0.45rem 0 1rem; box-sizing: border-box; border: 1px solid #d9dccf; border-radius: 8px; background: #fffef9; }
  button { background: #303928; color: #fffdf7; border: 0; border-radius: 999px; cursor: pointer; width: 100%; font-weight: 900; }
  button.secondary { background: #a84d37; margin-top: 0.7rem; }
  p.muted { color: #5f6259; font-size: 0.95rem; line-height: 1.5; }
  .plans { display: grid; grid-template-columns: 1fr 1fr; gap: 0.8rem; margin-top: 0.4rem; }
  .plan { padding: 0.9rem; box-shadow: none; }
  .plan h2 { margin-top: 0; }
  ul { padding-left: 1.2rem; color: #5f6259; line-height: 1.6; }
  .step { display: inline-block; padding: 0.25rem 0.55rem; border-radius: 999px; background: #e5ead8; color: #303928; font-size: 0.8rem; font-weight: 900; }
  @media (max-width: 760px) { .layout, .plans { grid-template-columns: 1fr; } }
</style></head>
<body>
  <span class="step">Step 1 of 2</span>
  <h1>Create your Orvex account</h1>
  <p class="muted">Register for a free trial or paid workspace first. GitHub installation unlocks only after this account step is complete.</p>

  <div class="layout">
    <section>
      <form method="post" action="/start">
        <label for="accountName">Your name</label>
        <input id="accountName" name="accountName" required autocomplete="name" placeholder="Jane Developer" />

        <label for="email">Work email</label>
        <input id="email" name="email" required type="email" autocomplete="email" placeholder="jane@company.com" value="${escapeHtml(email)}" />

        <label for="password">Create password</label>
        <input id="password" name="password" required type="password" minlength="8" autocomplete="new-password" placeholder="Minimum 8 characters" />

        <label for="tenant">Workspace slug</label>
        <input id="tenant" name="tenant" required pattern="[a-zA-Z0-9-]+" placeholder="acme" value="${escapeHtml(tenant)}" />

        <label for="name">Company / workspace name</label>
        <input id="name" name="name" required placeholder="Acme Corp" value="${escapeHtml(name)}" />

        <div class="plans">
          <div class="plan">
            <h2>Free trial</h2>
            <p class="muted">Try Orvex before billing. Best for first repo testing and PR workflow setup.</p>
            <button name="plan" value="trial" type="submit">Create account and start trial</button>
          </div>
          <div class="plan">
            <h2>Team plan</h2>
            <p class="muted">Use Orvex across team repositories after workspace registration.</p>
            <button class="secondary" name="plan" value="team" type="submit">Create account and continue</button>
          </div>
        </div>
      </form>
    </section>

    <aside class="aside">
      <h2>What happens next?</h2>
      <ul>
        <li>Your Orvex account and workspace are created first.</li>
        <li>Then we unlock a signed GitHub App install link.</li>
        <li>GitHub installs that skip this step are blocked and ignored.</li>
      </ul>
      <p class="muted">This keeps Orvex multi-tenant: every GitHub installation belongs to a registered trial or paying workspace.</p>
    </aside>
  </div>
</body></html>`);
  });

  app.get('/start', (c) => c.redirect('/connect'));

  app.post('/start', async (c) => {
    const body = await c.req.parseBody();
    const tenantSlug = String(body.tenant ?? '');
    const name = String(body.name ?? '');
    const accountName = String(body.accountName ?? '');
    const email = String(body.email ?? '');
    const password = String(body.password ?? '');
    const plan = String(body.plan ?? 'trial');

    if (!accountName.trim() || !email.includes('@') || password.length < 8) {
      return c.html(`<!DOCTYPE html><html><head><title>Account required</title><style>body{font-family:ui-sans-serif,system-ui,sans-serif;max-width:620px;margin:4rem auto;padding:0 1rem;color:#171713;background:#f7f5ed}.box{border:1px solid #d9dccf;border-radius:10px;padding:1.25rem;background:#fffdf7}a{color:#303928;font-weight:800}</style></head><body><h1>Account details required</h1><div class="box"><p>Please enter your name, a valid email, and a password with at least 8 characters before connecting GitHub.</p><p><a href="/connect">Back to account setup</a></p></div></body></html>`, 400);
    }

    if (!tenantSlug || !/^[a-zA-Z0-9-]+$/.test(tenantSlug)) {
      return c.redirect('/connect');
    }

    if (!['trial', 'team'].includes(plan)) {
      return c.json({ error: 'invalid plan' }, 400);
    }

    tenants.dbInstance.getOrCreateTenant(tenantSlug, name || undefined);
    const access = signInstallState({ tenantSlug, ts: Date.now() }, platformSecret());
    const params = new URLSearchParams({ tenant: tenantSlug, access, plan, email });
    if (name) params.set('name', name);

    return c.html(`<!DOCTYPE html>
<html><head><title>Orvex Review — Account created</title>
<style>
  body { font-family: ui-sans-serif, system-ui, sans-serif; max-width: 660px; margin: 4rem auto; padding: 0 1rem; color: #171713; background: #f7f5ed; }
  .box { border: 1px solid #d9dccf; border-radius: 14px; padding: 1.25rem; background: #fffdf7; box-shadow: 0 18px 50px rgba(48,57,40,0.08); }
  a.button { display: block; text-align: center; margin-top: 1rem; padding: 0.85rem; border-radius: 999px; background: #303928; color: #fffdf7; text-decoration: none; font-weight: 900; }
  p { color: #5f6259; line-height: 1.5; }
  .step { display: inline-block; padding: 0.25rem 0.55rem; border-radius: 999px; background: #e5ead8; color: #303928; font-size: 0.8rem; font-weight: 900; }
</style></head>
<body>
  <span class="step">Step 2 of 2</span>
  <h1>Account created</h1>
  <div class="box">
    <p><strong>${escapeHtml(accountName)}</strong>, your Orvex workspace <strong>${escapeHtml(tenantSlug)}</strong> is registered on the <strong>${escapeHtml(plan)}</strong> path.</p>
    <p>Next, install the Orvex Review GitHub App on the repositories this workspace should review.</p>
    <a class="button" href="/auth/github/install?${params.toString()}">Continue to GitHub install</a>
  </div>
</body></html>`);
  });

  app.get('/auth/github/install', (c) => {
    const tenantSlug = c.req.query('tenant');
    const name = c.req.query('name') ?? undefined;
    const access = c.req.query('access');
    if (!tenantSlug) {
      return c.redirect('/connect');
    }
    if (!access) {
      return c.redirect(`/connect?tenant=${encodeURIComponent(tenantSlug)}${name ? `&name=${encodeURIComponent(name)}` : ''}`);
    }
    const payload = verifyInstallState(access, platformSecret());
    if (!payload || payload.tenantSlug !== tenantSlug) {
      return c.json({ error: 'trial_or_plan_required' }, 403);
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

    if (!state) {
      return c.html(`<!DOCTYPE html>
<html><head><title>Orvex Review — Plan required</title>
<style>
  body { font-family: ui-sans-serif, system-ui, sans-serif; max-width: 620px; margin: 4rem auto; padding: 0 1rem; color: #171713; background: #f7f5ed; }
  .box { border: 1px solid #d9dccf; border-radius: 10px; padding: 1.25rem; background: #fffdf7; }
  a.button { display: block; text-align: center; margin-top: 1rem; padding: 0.8rem; border-radius: 6px; background: #303928; color: #fffdf7; text-decoration: none; font-weight: 800; }
  p { color: #5f6259; line-height: 1.5; }
</style></head>
<body>
  <h1>Plan required</h1>
  <div class="box">
    <p>This GitHub installation was not started from an Orvex trial or paid workspace.</p>
    <p>Create a workspace first, then continue to GitHub from Orvex onboarding.</p>
    <a class="button" href="/connect">Start Orvex onboarding</a>
  </div>
</body></html>`, 403);
    }

    const payload = verifyInstallState(state, platformSecret());
    if (!payload) {
      return c.json({ error: 'invalid or expired state' }, 400);
    }
    const tenantSlug = payload.tenantSlug;

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

  app.get('/', (c) => c.redirect('/dashboard'));

  return app;
}
