import { Hono } from 'hono';
import { loadGitHubConfigFromEnv } from '@orvex-review/github';
import { createAppDatabase } from '@orvex-review/store';
import {
  TenantService,
  WorkspaceAccessError,
  authDisabled,
  loadOAuthConfigFromEnv,
  verifyInstallState,
  platformSecret,
} from '@orvex-review/tenants';
import { loginRedirect, sessionUser } from './session.js';
import { escapeHtml, onboardingSteps, pageShell } from './pages.js';

/** True while user login (OAuth) is not configured — the pre-auth signup flow stays available. */
function legacyConnectMode(): boolean {
  return !loadOAuthConfigFromEnv() && !authDisabled();
}

const LEGACY_BANNER = `<div class="banner error">User accounts are not configured
(<code>GITHUB_OAUTH_CLIENT_ID</code> unset) — running the legacy connect flow without login.
Workspaces created here can be claimed by the first signed-in user once accounts are enabled.</div>`;

export function authRoutes() {
  const app = new Hono();
  const db = createAppDatabase();
  const tenants = new TenantService(db);

  // Old entry points (marketing links, GitHub App homepage) → connect flow.
  app.get('/dashboard', (c) => c.redirect('/connect'));
  app.get('/start', (c) => c.redirect('/connect'));
  app.post('/start', (c) => c.redirect('/connect', 303));

  app.get('/connect', (c) => {
    const user = sessionUser(c, db);
    if (!user && legacyConnectMode()) {
      const error = c.req.query('error');
      const errorBanner = error ? `<div class="banner error">${escapeHtml(error)}</div>` : '';
      return c.html(
        pageShell(
          'Connect GitHub',
          `${onboardingSteps(2)}
           ${errorBanner}
           ${LEGACY_BANNER}
           <h1>Start your workspace</h1>
           <p class="lead">Pick a workspace slug, then install the Orvex Review GitHub App and
           choose which repositories it can review.</p>
           <form method="get" action="/auth/github/install">
             <label for="tenant">Workspace slug</label>
             <input id="tenant" name="tenant" required pattern="[a-zA-Z0-9-]{2,40}" placeholder="acme" />
             <p class="hint">Lowercase letters, numbers, and dashes.</p>
             <label for="name">Display name <span style="font-weight:400;color:var(--ink-3)">(optional)</span></label>
             <input id="name" name="name" placeholder="Acme Corp" />
             <button type="submit">Continue to GitHub →</button>
           </form>
           <p class="muted" style="margin-top:14px">You'll authorize the GitHub App with scoped
           permissions — no passwords are ever shared.</p>`,
        ),
      );
    }
    if (!user) return loginRedirect(c, '/connect');

    const workspaces = db.getWorkspacesForUser(user.id);
    const error = c.req.query('error');

    const workspaceList = workspaces.length
      ? `<hr class="divider" />
         <h2>Your workspaces</h2>
         <p class="muted">Pick one to add more repositories, or create a new workspace above.</p>
         <ul class="ws-list">${workspaces
           .map(
             (w) => `<li>
               <a href="/auth/github/install?tenant=${encodeURIComponent(w.tenant.slug)}">${escapeHtml(w.tenant.name)}</a>
               <span class="slug">${escapeHtml(w.tenant.slug)}</span>
               <span class="role">${w.role}</span>
             </li>`,
           )
           .join('')}</ul>`
      : '';

    const errorBanner = error
      ? `<div class="banner error">${escapeHtml(error)}</div>`
      : '';

    const suggestedSlug = user.login.toLowerCase().replace(/[^a-z0-9-]/g, '-');

    return c.html(
      pageShell(
        'Connect GitHub',
        `${onboardingSteps(2)}
         ${errorBanner}
         <h1>Create your workspace</h1>
         <p class="lead">A workspace groups your GitHub installations, reviews, and billing.
         Next you'll pick which repositories Orvex can review — it never sees repos you don't select.</p>
         <form method="get" action="/auth/github/install">
           <label for="tenant">Workspace slug</label>
           <input id="tenant" name="tenant" required pattern="[a-zA-Z0-9-]{2,40}"
                  placeholder="${escapeHtml(suggestedSlug)}" value="${escapeHtml(suggestedSlug)}" />
           <p class="hint">Lowercase letters, numbers, and dashes. This becomes your workspace URL.</p>
           <label for="name">Display name <span style="font-weight:400;color:var(--ink-3)">(optional)</span></label>
           <input id="name" name="name" placeholder="Acme Corp" />
           <button type="submit">Continue to GitHub →</button>
         </form>
         <p class="muted" style="margin-top:14px">You'll authorize the Orvex Review GitHub App with
         read access to code and write access to pull requests — no passwords are ever shared.</p>
         ${workspaceList}`,
        user,
      ),
    );
  });

  app.get('/auth/github/install', (c) => {
    const user = sessionUser(c, db);
    const tenantSlug = c.req.query('tenant');
    const name = c.req.query('name') ?? undefined;
    if (!tenantSlug) {
      return c.redirect('/connect');
    }

    if (!user && legacyConnectMode()) {
      const { installUrl } = tenants.startConnectLegacy(tenantSlug, name);
      return c.redirect(installUrl);
    }
    if (!user) return loginRedirect(c, fullPath(c.req.url));

    try {
      const { installUrl } = tenants.startConnect(tenantSlug, user.id, name);
      return c.redirect(installUrl);
    } catch (err) {
      if (err instanceof WorkspaceAccessError) {
        return c.redirect(`/connect?error=${encodeURIComponent(err.message + ' — pick a different slug.')}`);
      }
      throw err;
    }
  });

  app.get('/auth/github/callback', async (c) => {
    const user = sessionUser(c, db);

    if (!user && legacyConnectMode()) {
      const legacyInstallationId = Number(c.req.query('installation_id'));
      if (!legacyInstallationId || Number.isNaN(legacyInstallationId)) {
        return c.json({ error: 'missing installation_id' }, 400);
      }
      let legacySlug = 'default';
      const legacyState = c.req.query('state');
      if (legacyState) {
        const payload = verifyInstallState(legacyState, platformSecret());
        if (!payload) return c.json({ error: 'invalid or expired state' }, 400);
        legacySlug = payload.tenantSlug;
      }
      try {
        const { tenant, installation } = await tenants.completeInstallCallback(
          legacyInstallationId,
          legacySlug,
          loadGitHubConfigFromEnv(),
        );
        return c.html(
          pageShell(
            'Connected',
            `${onboardingSteps(3)}
             <div class="banner ok">✓ GitHub connected</div>
             <h1>Workspace ready</h1>
             <p class="lead">Workspace <strong>${escapeHtml(tenant.name)}</strong> is linked to
             <strong>${escapeHtml(installation.accountLogin)}</strong>. Orvex reviews the next
             pull request automatically — comment <code>@orvex help</code> on any PR for commands.</p>
             ${LEGACY_BANNER}`,
          ),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return c.json({ error: message }, 500);
      }
    }

    if (!user) return loginRedirect(c, fullPath(c.req.url));

    const installationId = Number(c.req.query('installation_id'));
    const setupAction = c.req.query('setup_action');
    const state = c.req.query('state');

    if (!installationId || Number.isNaN(installationId)) {
      return c.html(
        pageShell(
          'Something went wrong',
          `<h1>Missing installation</h1>
           <p class="lead">GitHub didn't send an installation id. This usually means the
           installation was cancelled.</p>
           <a class="btn" href="/connect">Try again</a>`,
          user,
        ),
        400,
      );
    }

    let tenantSlug: string;
    if (state) {
      const payload = verifyInstallState(state, platformSecret());
      if (!payload) {
        return c.html(
          pageShell(
            'Link expired',
            `<h1>This install link expired</h1>
             <p class="lead">Start the connect flow again — it only takes a few seconds.</p>
             <a class="btn" href="/connect">Back to connect</a>`,
            user,
          ),
          400,
        );
      }
      if (payload.userId && payload.userId !== user.id) {
        return c.html(
          pageShell(
            'Wrong account',
            `<h1>Started by a different user</h1>
             <p class="lead">This installation was initiated from another account. Sign in with
             that account, or start a fresh connect flow.</p>
             <a class="btn" href="/connect">Start over</a>`,
            user,
          ),
          403,
        );
      }
      tenantSlug = payload.tenantSlug;
    } else {
      // Direct install from GitHub (no connect flow): personal workspace.
      tenantSlug = user.login.toLowerCase();
    }

    try {
      // Ensures membership; claims/creates the slug for this user if needed.
      tenants.startConnect(tenantSlug, user.id);
      const { tenant, installation } = await tenants.completeInstallCallback(
        installationId,
        tenantSlug,
        loadGitHubConfigFromEnv(),
      );

      return c.html(
        pageShell(
          'Connected',
          `${onboardingSteps(3)}
           <div class="banner ok">✓ GitHub connected${setupAction ? ` (${escapeHtml(setupAction)})` : ''}</div>
           <h1>You're all set, ${escapeHtml(user.login)}</h1>
           <p class="lead">Workspace <strong>${escapeHtml(tenant.name)}</strong> is linked to
           <strong>${escapeHtml(installation.accountLogin)}</strong>. Orvex reviews the next
           pull request automatically.</p>
           <dl class="kv">
             <div><dt>Workspace</dt><dd><code>${escapeHtml(tenant.slug)}</code></dd></div>
             <div><dt>GitHub account</dt><dd>${escapeHtml(installation.accountLogin)} (${escapeHtml(installation.accountType)})</dd></div>
             <div><dt>Repository access</dt><dd>${escapeHtml(installation.repositorySelection)}</dd></div>
             <div><dt>Installation ID</dt><dd><code>${installation.installationId}</code></dd></div>
           </dl>
           <hr class="divider" />
           <h2>Try it now</h2>
           <p class="muted">Open a pull request on a connected repo — Orvex posts its review
           within a couple of minutes. Comment <code>@orvex help</code> on any PR to see the
           fix commands.</p>
           <a class="btn" href="/api/workspaces/${tenant.slug}/stats">View workspace stats (JSON)</a>
           <a class="btn secondary" href="/connect">Add another workspace</a>`,
          user,
        ),
      );
    } catch (err) {
      if (err instanceof WorkspaceAccessError) {
        return c.redirect(`/connect?error=${encodeURIComponent(err.message)}`);
      }
      const message = err instanceof Error ? err.message : String(err);
      return c.html(
        pageShell(
          'Something went wrong',
          `<h1>Could not finish the installation</h1>
           <div class="banner error">${escapeHtml(message)}</div>
           <a class="btn" href="/connect">Try again</a>`,
          user,
        ),
        500,
      );
    }
  });

  // Legacy endpoint, now membership-guarded. Prefer /api/workspaces/:slug/*.
  app.get('/api/tenants/:slug', (c) => {
    const user = sessionUser(c, db);
    if (!user) return c.json({ error: 'not signed in' }, 401);
    try {
      const status = tenants.getTenantStatusForUser(c.req.param('slug'), user.id);
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
      });
    } catch (err) {
      if (err instanceof WorkspaceAccessError) {
        return c.json({ error: err.message }, err.status);
      }
      throw err;
    }
  });

  return app;
}

function fullPath(url: string): string {
  const u = new URL(url);
  return `${u.pathname}${u.search}`;
}
