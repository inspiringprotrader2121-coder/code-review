import { Hono } from 'hono';
import type { IdentityRepository } from '@orvex-review/store';
import { publicPlanLabel, type PlanFeatures } from '@orvex-review/tenants';
import { formatCommandsHtmlRows } from '@orvex-review/review';
import { logoutCsrfToken, sessionUser } from './session.js';
import { escapeHtml } from './pages.js';
import { assetHref } from '../assets/index.js';
import { dashboardBootstrapAttributes, type DashboardPageView } from '../ui/dashboard-view.js';
import type { ServerConfig } from '../bootstrap/config.js';
import {
  DashboardService,
  type DashboardStore,
} from '../application/workspace/dashboard-service.js';

export interface DashboardRouteDependencies {
  db: DashboardStore & Pick<IdentityRepository, 'getSessionUser' | 'upsertUserFromGitHub'>;
  config: Pick<
    ServerConfig,
    | 'appUrl'
    | 'authDisabled'
    | 'costVisibilityTenants'
    | 'oauth'
    | 'platformSecret'
    | 'requireLogin'
  >;
}

export function dashboardRoutes(dependencies: DashboardRouteDependencies) {
  const { db, config } = dependencies;
  const app = new Hono();
  const dashboard = new DashboardService(db, config);

  app.get('/dashboard', (c) => {
    const user = sessionUser(c, db, config);
    const destination = dashboard.landing(user?.id ?? null);
    if (destination.kind === 'legacy' || destination.kind === 'workspace')
      return c.redirect(`/dashboard/${destination.slug}`);
    return c.redirect(destination.kind === 'connect' ? '/connect' : '/auth/login?next=/dashboard');
  });

  app.get('/dashboard/:slug', (c) => {
    const slug = c.req.param('slug');
    // Slugs are [a-zA-Z0-9-] everywhere they're created; reject anything else
    // before it reaches the HTML data attribute used by the external asset.
    if (!/^[a-zA-Z0-9-]{1,40}$/.test(slug)) return c.redirect('/dashboard');
    const user = sessionUser(c, db, config);
    if (!user && dashboard.landing(null).kind !== 'legacy')
      return c.redirect(`/auth/login?next=/dashboard/${encodeURIComponent(slug)}`);
    const view = dashboard.view(slug, user);
    if (!view) return c.redirect('/dashboard');
    const billingState = c.req.query('billing');
    const billingBanner =
      billingState === 'success'
        ? '<div class="banner success" role="status">Payment received. Your plan is activating now; refresh in a moment if the new allowance is not visible yet.</div>'
        : billingState === 'cancelled'
          ? '<div class="banner" role="status">Checkout was cancelled. No plan change was made.</div>'
          : billingState === 'credits-success'
            ? '<div class="banner success" role="status">Prepaid credits added. Reviews past your included monthly quota will draw from this wallet.</div>'
            : billingState === 'credits-cancelled'
              ? '<div class="banner" role="status">Credit purchase was cancelled. No wallet change was made.</div>'
              : billingState === 'portal-error'
                ? '<div class="banner" role="alert">Billing management is temporarily unavailable. Please try again or email support@useorvex.com.</div>'
                : billingState === 'unavailable'
                  ? '<div class="banner" role="status">No active billing profile is connected yet. Choose a plan below to start billing.</div>'
                  : '';
    return c.html(
      dashboardHtml({
        workspaceSlug: slug,
        isSuperAdmin: view.isSuperAdmin,
        logoutCsrf: logoutCsrfToken(c, config),
        showLlmCost: view.showLlmCost,
        plan: view.plan,
        canManageBilling: view.canManageBilling,
        billingBannerHtml: billingBanner,
        creditBalanceCents: view.creditBalanceCents,
      }),
    );
  });

  return app;
}

function planQuotaSummary(plan: PlanFeatures): string {
  if (plan.id === 'enterprise') return 'custom plan capacity';
  const bits: string[] = [];
  if (plan.reviewsPerHour != null) bits.push(`${plan.reviewsPerHour}/hour`);
  else bits.push('unlimited hourly');
  if (plan.maxConcurrentReviews != null) bits.push(`${plan.maxConcurrentReviews} concurrent`);
  if (plan.trialReviewLimit != null) bits.push(`${plan.trialReviewLimit} lifetime free reviews`);
  else if (plan.includedReviewsPerMonth != null && plan.overageCentsPerReview != null) {
    bits.push(
      `${plan.includedReviewsPerMonth}/mo included · then $${(plan.overageCentsPerReview / 100).toFixed(2)} prepaid`,
    );
    if (plan.reviewsPerMonth != null) bits.push(`hard stop ${plan.reviewsPerMonth}/mo`);
  } else if (plan.reviewsPerMonth != null) bits.push(`${plan.reviewsPerMonth}/month hard cap`);
  else bits.push('unlimited monthly');
  return bits.join(' · ');
}

function dashboardHtml(view: DashboardPageView): string {
  const {
    workspaceSlug: slug,
    isSuperAdmin,
    logoutCsrf,
    showLlmCost,
    plan,
    canManageBilling,
    billingBannerHtml: billingBanner,
    creditBalanceCents,
  } = view;
  const planLabel = publicPlanLabel(plan);
  const quotaLine = planQuotaSummary(plan);
  const commandRows = formatCommandsHtmlRows('@orvex');

  // Icon set (inline SVG, stroke=currentColor so they inherit the nav colour).
  const ico = {
    overview:
      '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/></svg>',
    pulls:
      '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="2.4"/><circle cx="6" cy="18" r="2.4"/><path d="M6 8.4v7.2"/><circle cx="18" cy="6" r="2.4"/><path d="M18 8.4c0 6-8 3-8 9"/></svg>',
    findings:
      '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l9 16H3z"/><path d="M12 10v4"/><path d="M12 17h.01"/></svg>',
    repos:
      '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5a2 2 0 0 1 2-2h8l6 6v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><path d="M14 3v6h6"/></svg>',
    reviews:
      '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4v6h6"/><path d="M4 10a8 8 0 1 1 2.3 5.6"/></svg>',
    installs:
      '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="8" height="8" rx="2"/><rect x="13" y="3" width="8" height="8" rx="2"/><rect x="3" y="13" width="8" height="8" rx="2"/><rect x="13" y="13" width="8" height="8" rx="2"/></svg>',
    settings:
      '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 0 1-4 0v-.1A1.6 1.6 0 0 0 7 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3 15a2 2 0 0 1 0-4 1.6 1.6 0 0 0 1.6-2.7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 9 4.6 1.6 1.6 0 0 0 11 3a2 2 0 0 1 4 0 1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.6 1.6 0 0 0 21 11a2 2 0 0 1 0 4z"/></svg>',
  };

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light dark" />
<title>Orvex Review — Dashboard</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 32 32%22%3E%3Crect width=%2232%22 height=%2232%22 rx=%227%22 fill=%22%233ddc97%22/%3E%3Ctext x=%2216%22 y=%2222%22 font-size=%2222%22 font-family=%22monospace%22 font-weight=%22700%22 text-anchor=%22middle%22 fill=%22%230a0c10%22%3E%C2%B1%3C/text%3E%3C/svg%3E" />
<link rel="stylesheet" href="${assetHref('dashboard.css')}" /></head>
<body ${dashboardBootstrapAttributes(view)}>
<div class="app">
  <aside class="sidebar">
    <div class="brand"><div class="glyph">±</div><div><span class="word">Orvex</span><span class="tag">Review</span></div></div>
    <a class="switcher" href="/dashboard"><span class="ws-ava" id="wsAvatar">·</span><span class="ws-name"><span id="wsName">…</span><br><span class="ws-slug" id="wsSlug"></span></span></a>
    <nav class="nav" aria-label="Primary" role="tablist">
      <div class="nav-label">Workspace</div>
      <button type="button" class="active" data-view="overview" id="tab-overview" role="tab" aria-controls="v-overview" aria-selected="true">${ico.overview}Overview</button>
      <button type="button" data-view="pulls" id="tab-pulls" role="tab" aria-controls="v-pulls" aria-selected="false">${ico.pulls}Pull requests <span class="count" id="cPulls"></span></button>
      <button type="button" data-view="findings" id="tab-findings" role="tab" aria-controls="v-findings" aria-selected="false">${ico.findings}Findings <span class="count" id="cFind"></span></button>
      <button type="button" data-view="reviews" id="tab-reviews" role="tab" aria-controls="v-reviews" aria-selected="false">${ico.reviews}Review runs</button>
      <button type="button" data-view="repos" id="tab-repos" role="tab" aria-controls="v-repos" aria-selected="false">${ico.repos}Repositories <span class="count" id="cRepos"></span></button>
      <button type="button" data-view="installs" id="tab-installs" role="tab" aria-controls="v-installs" aria-selected="false">${ico.installs}Installations</button>
      <button type="button" data-view="settings" id="tab-settings" role="tab" aria-controls="v-settings" aria-selected="false">${ico.settings}Settings</button>
    </nav>
    <div class="side-foot">
      <button class="theme-toggle" id="themeBtn" aria-label="Toggle light and dark theme">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
        <span id="themeLabel">Theme</span><span class="tt-track"><span class="tt-knob"></span></span>
      </button>
      ${isSuperAdmin ? `<a href="/superadmin" class="side-link">${ico.settings}Super admin</a>` : ''}
      <a href="/settings/security" class="side-link">Account security</a>
      <a href="/connect" class="side-link">Add repositories</a>
      ${logoutCsrf ? `<form method="post" action="/auth/logout" class="sign-out"><input type="hidden" name="csrf" value="${logoutCsrf}" /><button type="submit">Sign out</button></form>` : ''}
    </div>
  </aside>

  <div class="main">
    <header class="topbar">
      <div class="page-h"><span class="crumb"><b id="crumbWs">—</b> &nbsp;/&nbsp; <span id="crumbView">Overview</span></span><span class="t" id="viewTitle" tabindex="-1" aria-live="polite">Overview</span></div>
      <div class="top-right"><button class="btn" id="refresh">Refresh</button><div class="avatar" id="avatar" title="Your account">·</div></div>
    </header>
    <nav class="mobile-nav" aria-label="Mobile workspace navigation">
      <button class="active" data-view="overview">Overview</button>
      <button data-view="pulls">Pull requests</button>
      <button data-view="findings">Findings</button>
      <button data-view="reviews">Runs</button>
      <button data-view="settings">Settings</button>
      <a href="/connect">Add repos</a>
      <a href="/settings/security">Security</a>
    </nav>

    <div class="content">
      <div class="banner" id="legacyBanner" hidden>Viewing without login — set <code>GITHUB_OAUTH_CLIENT_ID</code> to require sign-in.</div>
      ${billingBanner}

      <!-- OVERVIEW -->
      <div class="view active" id="v-overview" role="tabpanel" aria-labelledby="tab-overview">
        <section class="tiles" id="tiles"><div class="loading">Loading…</div></section>
        <section class="grid-2">
          <div class="panel"><div class="panel-h"><div><h2>Reviews per day</h2><span class="sub">Completed review runs · last 14 days</span></div></div>
            <div class="chart-wrap"><div class="chart" id="chart"><svg viewBox="0 0 640 210" role="img" aria-label="Reviews per day"><g id="gGrid"></g><g id="gBars"></g><g id="gX"></g><g id="gY"></g></svg><p id="chartDescription" class="sr-only"></p><div class="tip" id="tip"></div></div></div>
          </div>
          <div class="panel"><div class="panel-h"><div><h2>Findings by severity</h2><span class="sub" id="sevSub">—</span></div><div class="spacer"></div><button class="btn btn-compact" data-view="findings">View all</button></div>
            <div class="sev-panel-body" id="sevBody"></div>
          </div>
        </section>
        <section class="grid-2">
          <div class="panel"><div class="panel-h"><div><h2>Review runs</h2><span class="sub">Latest across the workspace</span></div><div class="spacer"></div><button class="btn btn-compact" data-view="reviews">Open runs →</button></div>
            <div class="table-scroll"><table class="runs"><thead><tr><th>Repository</th><th>PR</th><th>Trigger</th><th>Status</th><th class="r">New</th><th class="r">Duration</th><th class="r">When</th></tr></thead><tbody id="recentBody"></tbody></table></div>
          </div>
          <div class="panel"><div class="panel-h"><div><h2>Deep vs Normal</h2><span class="sub">Completed runs · last 14 days</span></div></div>
            <div class="panel-body" id="deepBody"><div class="loading">Loading…</div></div>
          </div>
        </section>
      </div>

      <!-- PULLS --><div class="view" id="v-pulls" role="tabpanel" aria-labelledby="tab-pulls"><div class="panel"><div class="panel-h"><div><h2>Pull requests</h2><span class="sub" id="pullSub">—</span></div></div><div class="table-scroll"><table class="runs"><thead><tr><th>Repo</th><th>PR</th><th>State</th><th class="r">Open bugs</th><th class="r">Reviewed</th></tr></thead><tbody id="pullBody"></tbody></table></div></div></div>
      <!-- FINDINGS --><div class="view" id="v-findings" role="tabpanel" aria-labelledby="tab-findings"><div class="panel"><div class="panel-h"><div><h2>Findings</h2><span class="sub">Bugs Orvex found, most severe first.</span></div></div><div class="table-scroll"><table class="runs"><thead><tr><th>Sev</th><th>Repo · PR</th><th>File</th><th>Finding</th><th>Status</th></tr></thead><tbody id="findBody"></tbody></table></div></div></div>
          <!-- REVIEWS --><div class="view" id="v-reviews" role="tabpanel" aria-labelledby="tab-reviews"><div class="panel"><div class="panel-h"><div><h2>Review runs</h2><span class="sub">Every review &amp; fix run, newest first.</span></div></div><div class="table-scroll"><table class="runs"><thead><tr><th>Repo</th><th>PR</th><th>Trigger</th><th>Status</th>${showLlmCost ? '<th class="r">LLM cost</th>' : ''}<th class="r">Duration</th><th class="r">When</th></tr></thead><tbody id="reviewsBody"></tbody></table></div></div></div>
      <!-- REPOS --><div class="view" id="v-repos" role="tabpanel" aria-labelledby="tab-repos"><div class="panel"><div class="panel-h"><div><h2>Repositories</h2><span class="sub">Toggle which repos Orvex reviews.</span></div><div class="spacer"></div><button class="btn" id="syncRepos">Sync from GitHub</button></div><div class="panel-body" id="reposList"><div class="loading">Loading…</div></div></div></div>
      <!-- INSTALLS --><div class="view" id="v-installs" role="tabpanel" aria-labelledby="tab-installs"><div class="panel"><div class="panel-h"><div><h2>GitHub installations</h2><span class="sub">Orgs where the Orvex App is installed.</span></div></div><div class="panel-body" id="installs"><div class="loading">Loading…</div></div></div></div>
      <!-- SETTINGS --><div class="view" id="v-settings" role="tabpanel" aria-labelledby="tab-settings">
        <div class="panel"><div class="panel-h"><div><h2>Plan and billing</h2><span class="sub">Current plan: ${escapeHtml(planLabel)} · billed per workspace.</span></div></div><div class="panel-body">${
          canManageBilling
            ? `<a class="btn" href="/#pricing">View plans</a> <a class="btn" href="/billing/portal/${encodeURIComponent(slug)}">Manage billing</a> <a class="btn" href="mailto:support@useorvex.com?subject=${encodeURIComponent(`Orvex billing help - ${slug}`)}">Billing help</a>`
            : '<span class="muted">Only a workspace owner can change the plan or request cancellation.</span>'
        }<p class="muted allowance-copy">Your allowance: <strong>${escapeHtml(quotaLine)}</strong>. Comment <code>@orvex rate limit</code> on any PR to see remaining capacity.</p>
          ${
            plan.overageCentsPerReview != null
              ? `<div class="wallet"><p class="wallet-summary"><strong>Prepaid overage wallet:</strong> $${(creditBalanceCents / 100).toFixed(2)} · $${(plan.overageCentsPerReview / 100).toFixed(2)}/review after included quota</p>
          ${
            canManageBilling
              ? `<p class="muted wallet-note">Add money before reviews past your included monthly total. Credits are charged only when a review actually runs.</p>
          <button class="btn" type="button" data-buy-credits="1000">Buy $10</button>
          <button class="btn" type="button" data-buy-credits="2500">Buy $25</button>
          <button class="btn" type="button" data-buy-credits="5000">Buy $50</button>
          <button class="btn" type="button" data-buy-credits="10000">Buy $100</button>`
              : '<p class="muted wallet-note wallet-note-last">Ask a workspace owner to add prepaid credits.</p>'
          }
          </div>`
              : ''
          }
          </div></div>
        <div class="panel"><div class="panel-h"><div><h2>Account security</h2><span class="sub">Password and authenticator settings.</span></div></div><div class="panel-body"><a class="btn" href="/settings/security">Manage account security</a></div></div>
        <div class="panel"><div class="panel-h"><div><h2>Privacy and data</h2><span class="sub">Review the policy or request a copy or deletion of workspace data.</span></div></div><div class="panel-body"><a class="btn" href="/privacy">Privacy policy</a> <a class="btn" href="mailto:support@useorvex.com?subject=${encodeURIComponent(`Orvex data request - ${slug}`)}">Request data help</a></div></div>
        <div class="panel"><div class="panel-h"><div><h2>Automatic review triggers</h2><span class="sub">Per repo. <code>@orvex review</code> always works regardless.</span></div></div><div class="panel-body" id="settingsList"><div class="loading">Loading…</div></div></div>
        <div class="panel"><div class="panel-h"><div><h2>GitHub commands</h2><span class="sub">Comment these on a pull request. Same list as <code>@orvex help</code>.</span></div></div><div class="panel-body">
          <p class="muted command-copy">Orvex reviews when a PR opens and (if enabled above) on each push. Manual commands always work. A standard review uses <strong>1</strong> unit; <code>@orvex deep</code> uses <strong>2</strong>. Skipped reviews and fix/explain commands do not consume units; failed reviews still count toward free-trial and hourly caps. Tick <strong>Apply this fix</strong> on an inline finding to commit that one fix.</p>
          <div class="table-scroll"><table class="runs"><thead><tr><th>Command</th><th>Where</th><th>Effect</th></tr></thead><tbody>${commandRows}</tbody></table></div>
          <p class="muted command-help">Need the list on a PR? Comment <code>@orvex help</code>. Check quota without starting a review: <code>@orvex rate limit</code>.</p>
        </div></div>
      </div>
    </div>
  </div>
</div>
<script src="${assetHref('dashboard.js')}" defer></script>
</body></html>`;
}
