import { Hono } from 'hono';
import { createAppDatabase } from '@orvex-review/store';
import { legacyAuthMode, planFeatures, publicPlanLabel, type PlanFeatures } from '@orvex-review/tenants';
import { formatCommandsHtmlRows } from '@orvex-review/review';
import { logoutCsrfToken, sessionUser } from './session.js';
import { llmCostVisibleForTenant } from './cost-visibility.js';
import { escapeHtml } from './pages.js';

export function dashboardRoutes() {
  const app = new Hono();
  const db = createAppDatabase();

  app.get('/dashboard', (c) => {
    if (legacyAuthMode(db.hasPasswordUsers())) {
      const slug = db.firstTenantSlug() ?? 'default';
      return c.redirect(`/dashboard/${slug}`);
    }
    const user = sessionUser(c, db);
    if (!user) return c.redirect('/auth/login?next=/dashboard');
    const ws = db.getWorkspacesForUser(user.id);
    if (ws.length === 0) return c.redirect('/connect');
    return c.redirect(`/dashboard/${ws[0].tenant.slug}`);
  });

  app.get('/dashboard/:slug', (c) => {
    const slug = c.req.param('slug');
    // slugs are [a-zA-Z0-9-] everywhere they're created; reject anything else
    // before it reaches the inline <script> below (XSS defense in depth)
    if (!/^[a-zA-Z0-9-]{1,40}$/.test(slug)) return c.redirect('/dashboard');
    const tenant = db.getTenantBySlug(slug);
    const showLlmCost = Boolean(tenant && llmCostVisibleForTenant(tenant.slug));
    let isSuperAdmin = false;
    let canManageBilling = true;
    if (!legacyAuthMode(db.hasPasswordUsers())) {
      const user = sessionUser(c, db);
      if (!user) return c.redirect(`/auth/login?next=/dashboard/${encodeURIComponent(slug)}`);
      const membership = tenant ? db.getMembership(tenant.id, user.id) : null;
      if (!tenant || !membership) return c.redirect('/dashboard');
      isSuperAdmin = user.isSuperAdmin;
      canManageBilling = membership.role === 'owner';
    }
    const plan = tenant ? planFeatures(db.getTenantPlan(tenant.id)) : planFeatures('free');
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
      dashboardHtml(
        slug,
        isSuperAdmin,
        logoutCsrfToken(c),
        showLlmCost,
        plan,
        canManageBilling,
        billingBanner,
        tenant ? db.getCreditBalanceCents(tenant.id) : 0,
      ),
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

function dashboardHtml(
  slug: string,
  isSuperAdmin: boolean,
  logoutCsrf: string | null,
  showLlmCost: boolean,
  plan: PlanFeatures,
  canManageBilling: boolean,
  billingBanner: string,
  creditBalanceCents = 0,
): string {
  // JSON.stringify alone leaves `</script>` intact — escape for an inline <script> sink
  const s = JSON.stringify(slug)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
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
<script>
  // Apply the saved theme before first paint (no flash).
  (function(){try{var t=localStorage.getItem('orvex-theme');if(t==='dark'||t==='light')document.documentElement.setAttribute('data-theme',t);}catch(e){}})();
</script>
<style>
  :root{
    --ground:#fafbfc; --panel:#fff; --panel-2:#f4f6f9; --raise:#fff;
    --border:#e4e8ee; --border-2:#d7dce4; --ink:#0b0d11; --ink-2:#55606f; --ink-3:#8a94a3;
    --accent:#16b57f; --accent-ink:#05130d; --accent-soft:rgba(22,181,127,.12);
    --p1:#e5484d; --p1-soft:rgba(229,72,77,.13); --p2:#c9760a; --p2-soft:rgba(201,118,10,.14);
    --p3:#3b7dd8; --p3-soft:rgba(59,125,216,.13); --info:#7a8699; --info-soft:rgba(122,134,153,.14);
    --good:#16b57f; --good-soft:rgba(22,181,127,.13);
    --grid:rgba(11,13,17,.07); --shadow:0 1px 2px rgba(11,13,17,.05),0 8px 24px rgba(11,13,17,.05);
    --focus:#16b57f;
    --mono:ui-monospace,"SF Mono","SFMono-Regular",Menlo,Consolas,monospace;
  }
  @media (prefers-color-scheme:dark){:root{
    --ground:#0b0d11; --panel:#12151b; --panel-2:#0f1218; --raise:#161a22;
    --border:#1c212b; --border-2:#262d3a; --ink:#e8ecf2; --ink-2:#98a2b3; --ink-3:#5c6675;
    --accent:#3ddc97; --accent-ink:#05130d; --accent-soft:rgba(61,220,151,.11);
    --p1:#ff5c5c; --p1-soft:rgba(255,92,92,.13); --p2:#ffb020; --p2-soft:rgba(255,176,32,.13);
    --p3:#5b9bff; --p3-soft:rgba(91,155,255,.13); --info:#7d8798; --info-soft:rgba(125,135,152,.16);
    --good:#3ddc97; --good-soft:rgba(61,220,151,.12);
    --grid:rgba(255,255,255,.05); --shadow:0 1px 2px rgba(0,0,0,.4),0 12px 32px rgba(0,0,0,.35);
    --focus:#3ddc97;
  }}
  :root[data-theme="light"]{
    --ground:#fafbfc; --panel:#fff; --panel-2:#f4f6f9; --raise:#fff;
    --border:#e4e8ee; --border-2:#d7dce4; --ink:#0b0d11; --ink-2:#55606f; --ink-3:#8a94a3;
    --accent:#16b57f; --accent-ink:#05130d; --accent-soft:rgba(22,181,127,.12);
    --p1:#e5484d; --p1-soft:rgba(229,72,77,.13); --p2:#c9760a; --p2-soft:rgba(201,118,10,.14);
    --p3:#3b7dd8; --p3-soft:rgba(59,125,216,.13); --info:#7a8699; --info-soft:rgba(122,134,153,.14);
    --good:#16b57f; --good-soft:rgba(22,181,127,.13);
    --grid:rgba(11,13,17,.07); --shadow:0 1px 2px rgba(11,13,17,.05),0 8px 24px rgba(11,13,17,.05);
    --focus:#16b57f;
  }
  :root[data-theme="dark"]{
    --ground:#0b0d11; --panel:#12151b; --panel-2:#0f1218; --raise:#161a22;
    --border:#1c212b; --border-2:#262d3a; --ink:#e8ecf2; --ink-2:#98a2b3; --ink-3:#5c6675;
    --accent:#3ddc97; --accent-ink:#05130d; --accent-soft:rgba(61,220,151,.11);
    --p1:#ff5c5c; --p1-soft:rgba(255,92,92,.13); --p2:#ffb020; --p2-soft:rgba(255,176,32,.13);
    --p3:#5b9bff; --p3-soft:rgba(91,155,255,.13); --info:#7d8798; --info-soft:rgba(125,135,152,.16);
    --good:#3ddc97; --good-soft:rgba(61,220,151,.12);
    --grid:rgba(255,255,255,.05); --shadow:0 1px 2px rgba(0,0,0,.4),0 12px 32px rgba(0,0,0,.35);
    --focus:#3ddc97;
  }

  *{box-sizing:border-box} html,body{height:100%}
  body{margin:0;background:var(--ground);color:var(--ink);font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-size:14px;line-height:1.45;-webkit-font-smoothing:antialiased}
  h1,h2,h3{margin:0;font-weight:600} a{color:inherit;text-decoration:none}
  button{font-family:inherit;color:inherit;cursor:pointer} code{font-family:var(--mono);font-size:.92em}
  .mono{font-family:var(--mono);font-variant-numeric:tabular-nums} .num{font-variant-numeric:tabular-nums}
  :focus-visible{outline:2px solid var(--focus);outline-offset:2px;border-radius:6px}

  .app{display:grid;grid-template-columns:244px minmax(0,1fr);min-height:100vh}
  .sidebar{position:sticky;top:0;align-self:start;height:100vh;display:flex;flex-direction:column;gap:4px;padding:18px 14px;background:var(--panel-2);border-right:1px solid var(--border)}
  .brand{display:flex;align-items:center;gap:10px;padding:6px 8px 14px}
  .brand .glyph{width:30px;height:30px;border-radius:9px;display:grid;place-items:center;background:var(--accent);color:var(--accent-ink);font-weight:800;font-size:19px;line-height:1}
  .brand .word{font-size:16px;font-weight:700;letter-spacing:0} .brand .tag{display:block;font-size:10.5px;color:var(--ink-3);font-weight:500}
  .switcher{display:flex;align-items:center;gap:10px;width:100%;margin-bottom:12px;padding:8px 10px;border-radius:10px;background:var(--raise);border:1px solid var(--border);text-align:left}
  .switcher .ws-ava{width:22px;height:22px;border-radius:6px;flex:none;background:linear-gradient(135deg,#5b9bff,#16b57f);display:grid;place-items:center;color:#fff;font-size:11px;font-weight:700}
  .switcher .ws-name{flex:1;min-width:0;font-weight:600;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .switcher .ws-slug{font-size:11px;color:var(--ink-3);font-family:var(--mono)}
  .nav-label{font-size:10.5px;letter-spacing:.8px;text-transform:uppercase;color:var(--ink-3);padding:10px 10px 4px;font-weight:600}
  .nav a{display:flex;align-items:center;gap:11px;padding:8px 10px;border-radius:9px;color:var(--ink-2);font-weight:500;cursor:pointer;border:0;background:none;width:100%;text-align:left;font-size:13.5px}
  .nav a:hover{background:var(--raise);color:var(--ink)} .nav a.active{background:var(--accent-soft);color:var(--ink);font-weight:600}
  .nav a .ico{width:17px;height:17px;flex:none;color:var(--ink-3)} .nav a.active .ico{color:var(--accent)}
  .nav .count{margin-left:auto;font-size:11px;color:var(--ink-3);font-family:var(--mono)} .nav a.active .count{color:var(--accent)}
  .side-foot{margin-top:auto;padding-top:12px;border-top:1px solid var(--border);display:flex;flex-direction:column;gap:2px}
  .theme-toggle{display:flex;align-items:center;gap:8px;width:100%;padding:8px 10px;border-radius:10px;background:var(--raise);border:1px solid var(--border);font-size:12.5px;font-weight:500;color:var(--ink-2);margin-bottom:6px}
  .theme-toggle:hover{border-color:var(--border-2);color:var(--ink)}
  .theme-toggle .tt-track{margin-left:auto;width:34px;height:20px;border-radius:999px;background:var(--border-2);position:relative;transition:background .2s;flex:none}
  .theme-toggle .tt-knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--ink);transition:transform .2s}
  html.is-dark .theme-toggle .tt-track{background:var(--accent)} html.is-dark .theme-toggle .tt-knob{transform:translateX(14px);background:#05130d}

  .main{min-width:0;display:flex;flex-direction:column}
  .topbar{position:sticky;top:0;z-index:20;display:flex;align-items:center;gap:18px;padding:14px 26px;background:var(--ground);border-bottom:1px solid var(--border)}
  .page-h{display:flex;flex-direction:column;gap:1px} .page-h .crumb{font-size:12.5px;color:var(--ink-3)} .page-h .crumb b{color:var(--ink-2);font-weight:600}
  .page-h .t{font-size:18px;font-weight:700;letter-spacing:0}
  .top-right{margin-left:auto;display:flex;align-items:center;gap:12px}
  .btn{border:1px solid var(--border);background:var(--panel);color:var(--ink);border-radius:9px;padding:7px 13px;font-size:12.5px;font-weight:600}
  .btn:hover{border-color:var(--border-2)}
  .avatar{width:32px;height:32px;border-radius:50%;flex:none;background:linear-gradient(135deg,#ffb020,#e5484d);display:grid;place-items:center;color:#fff;font-weight:700;font-size:13px;box-shadow:0 0 0 2px var(--border)}
  .content{padding:22px 26px 44px;display:flex;flex-direction:column;gap:18px}
  .banner{background:var(--p2-soft);color:var(--p2);border-radius:10px;padding:10px 14px;font-size:13px}
  .banner.success{background:var(--good-soft);color:var(--good)}

  .panel{background:var(--panel);border:1px solid var(--border);border-radius:14px;box-shadow:var(--shadow)}
  .panel-h{display:flex;align-items:center;gap:12px;padding:14px 16px;border-bottom:1px solid var(--border)}
  .panel-h h2{font-size:13.5px;font-weight:650} .panel-h .sub{font-size:11.5px;color:var(--ink-3)} .panel-h .spacer{margin-left:auto}
  .panel-body{padding:16px}

  .tiles{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:14px}
  .tile{padding:15px 16px 14px;background:var(--panel);border:1px solid var(--border);border-radius:14px;box-shadow:var(--shadow);display:flex;flex-direction:column;gap:9px;min-width:0}
  .tile .tl{display:flex;align-items:center;gap:7px;font-size:11.5px;color:var(--ink-2);font-weight:600} .tile .tl .ti{width:14px;height:14px;color:var(--ink-3);flex:none}
  .tile .big{font-size:26px;font-weight:700;letter-spacing:0;line-height:1} .tile .big small{font-size:14px;font-weight:600;color:var(--ink-3);letter-spacing:0}
  .tile .foot{display:flex;align-items:center;gap:8px;margin-top:auto} .tile .cap{font-size:11px;color:var(--ink-3)}
  .delta{display:inline-flex;align-items:center;gap:3px;font-size:11.5px;font-weight:700;padding:2px 6px;border-radius:999px}
  .delta.up{color:var(--good);background:var(--good-soft)} .delta.down{color:var(--p1);background:var(--p1-soft)} .delta.flat{color:var(--ink-2);background:var(--info-soft)}
  .spark svg{display:block;width:100%;height:34px}
  .sevsplit{display:flex;height:7px;border-radius:999px;overflow:hidden;background:var(--border)} .sevsplit span{height:100%}
  .sevkeys{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:11px;color:var(--ink-2)} .sevkeys i{width:8px;height:8px;border-radius:2px;display:inline-block;margin-right:5px;vertical-align:middle}

  .grid-2{display:grid;grid-template-columns:minmax(0,1.9fr) minmax(0,1fr);gap:18px}
  .chart-wrap{padding:10px 10px 6px} .chart-wrap svg{display:block;max-width:100%} .chart{position:relative}
  .chart .tip{position:absolute;pointer-events:none;z-index:5;background:var(--ink);color:var(--ground);font-size:11.5px;padding:6px 9px;border-radius:7px;transform:translate(-50%,-115%);white-space:nowrap;opacity:0;transition:opacity .1s}
  .chart .tip strong{font-family:var(--mono)}
  .bar-rect{transition:opacity .1s} .bar-group:hover .bar-rect{opacity:.82}

  .sev-panel-body{padding:14px 16px 16px;display:flex;flex-direction:column;gap:13px}
  .sevbar-row{display:grid;grid-template-columns:96px 1fr auto;align-items:center;gap:12px}
  .sevbar-row .lbl{display:flex;align-items:center;gap:8px;font-size:12.5px;font-weight:600} .sevbar-row .lbl i{width:9px;height:9px;border-radius:3px;flex:none}
  .sevbar-track{height:22px;background:var(--panel-2);border:1px solid var(--border);border-radius:7px;overflow:hidden} .sevbar-fill{height:100%;width:100%;transform-origin:left center;border-radius:6px 0 0 6px;transition:transform .6s cubic-bezier(.22,1,.36,1)}
  .sevbar-row .cnt{font-size:13px;font-weight:700;min-width:22px;text-align:right}
  .sev-foot{display:flex;align-items:center;gap:9px;margin-top:3px;padding:10px 12px;border-radius:10px;background:var(--good-soft);font-size:12.5px;color:var(--ink);font-weight:500}
  .sev-foot .chk{width:18px;height:18px;border-radius:50%;background:var(--good);color:#05130d;display:grid;place-items:center;flex:none}
  .srcbar{display:grid;grid-template-columns:96px 1fr auto;align-items:center;gap:12px} .srcbar .lbl{font-size:12.5px;font-weight:600;text-transform:capitalize}

  .table-scroll{overflow-x:auto}
  table.runs{width:100%;border-collapse:collapse;min-width:640px}
  table.runs th{text-align:left;font-size:10.5px;letter-spacing:.5px;text-transform:uppercase;color:var(--ink-3);font-weight:600;padding:9px 14px;border-bottom:1px solid var(--border);white-space:nowrap}
  table.runs th.r,table.runs td.r{text-align:right}
  table.runs td{padding:11px 14px;border-bottom:1px solid var(--border);white-space:nowrap;font-size:12.5px;color:var(--ink-2)} table.runs tr:last-child td{border-bottom:none}
  table.runs tbody tr:hover{background:var(--panel-2)} .repo{color:var(--ink);font-weight:600} .repo .org{color:var(--ink-3);font-weight:400}
  .pr-t{color:var(--ink-2);max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:inline-block;vertical-align:bottom}
  .trig{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--ink-2)} .trig .tdot{width:6px;height:6px;border-radius:2px;background:var(--ink-3)}
  .trig.deep{color:var(--ink);font-weight:600} .trig.deep .tdot{background:var(--accent)}
  .trig.manual .tdot{background:var(--accent)} .trig.manual{color:var(--ink);font-weight:600}
  .trig.auto .tdot{background:var(--p3)} .trig.commit .tdot{background:var(--p2)}
  .chip{display:inline-flex;align-items:center;gap:6px;padding:3px 9px 3px 7px;border-radius:999px;font-size:11.5px;font-weight:650;border:1px solid transparent;white-space:nowrap}
  .chip .cd{width:7px;height:7px;border-radius:50%}
  .chip.done{color:var(--good);background:var(--good-soft)} .chip.done .cd{background:var(--good)}
  .chip.run{color:var(--p3);background:var(--p3-soft)} .chip.run .cd{background:var(--p3)}
  .chip.fail{color:var(--p1);background:var(--p1-soft)} .chip.fail .cd{background:var(--p1)}
  .chip.queued,.chip.muted{color:var(--ink-2);background:var(--info-soft)} .chip.queued .cd,.chip.muted .cd{background:var(--ink-3)}
  .chip.p1{color:var(--p1);background:var(--p1-soft)} .chip.p2{color:var(--p2);background:var(--p2-soft)} .chip.p3{color:var(--p3);background:var(--p3-soft)} .chip.ok{color:var(--good);background:var(--good-soft)}
  @media (prefers-reduced-motion:no-preference){.chip.run .cd{animation:pulse 1.2s ease-in-out infinite}@keyframes pulse{50%{opacity:.35}}}

  .dvn-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  .dvn-card{padding:13px;border-radius:11px;border:1px solid var(--border);background:var(--panel-2)} .dvn-card.deep{border-color:color-mix(in srgb,var(--accent) 34%,transparent);background:var(--accent-soft)}
  .dvn-card .k{font-size:11px;color:var(--ink-3);font-weight:600;text-transform:uppercase;letter-spacing:.4px;display:flex;align-items:center;gap:6px} .dvn-card .k i{width:7px;height:7px;border-radius:50%;background:var(--ink-3)} .dvn-card.deep .k i{background:var(--accent)}
  .dvn-card .runs{font-size:22px;font-weight:700;letter-spacing:0;margin-top:7px} .dvn-card .runs small{font-size:12px;font-weight:600;color:var(--ink-3)}
  .dvn-card .avg{font-size:12px;color:var(--ink-2);margin-top:2px} .dvn-card .avg b{color:var(--ink);font-family:var(--mono)}

  .repo-row,.settings-row{padding:12px 2px;border-bottom:1px solid var(--border)} .repo-row:last-child,.settings-row:last-child{border-bottom:0}
  .repo-row{display:flex;align-items:center;gap:10px} .repo-row .rn{font-weight:600;font-size:13.5px} .repo-row .rm{margin-left:auto;display:flex;align-items:center;gap:10px}
  .toggle{position:relative;width:38px;height:22px;border-radius:999px;background:var(--panel-2);border:1px solid var(--border-2);flex:none;transition:background .15s} .toggle[aria-checked="true"]{background:var(--accent);border-color:var(--accent)}
  .toggle::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:left .15s} .toggle[aria-checked="true"]::after{left:18px}
  .settings-row .sr-head{display:flex;align-items:center;gap:10px;margin-bottom:10px} .settings-row .rn{font-weight:600;font-size:13.5px}
  .sr-toggles{display:flex;flex-direction:column;gap:12px} .sr-toggle{display:flex;align-items:flex-start;gap:12px;cursor:pointer} .sr-toggle .toggle{margin-top:1px} .sr-toggle strong{font-size:13px;font-weight:600}
  .install-row{display:flex;align-items:center;gap:12px;padding:12px 2px;border-bottom:1px solid var(--border)} .install-row:last-child{border-bottom:0}
  .install-row .org{font-weight:650;font-size:13.5px} .install-row .meta{font-size:12px;color:var(--ink-3);font-family:var(--mono)} .install-row .right{margin-left:auto}
  .ghost{border:1px solid var(--border);background:transparent;color:var(--ink-2);border-radius:8px;padding:5px 11px;font-size:12px;font-weight:600} .ghost:hover{border-color:var(--border-2)}
  .muted{color:var(--ink-3)} .empty,.loading{color:var(--ink-3);font-size:13px;padding:16px 2px}
  .view{display:none} .view.active{display:flex;flex-direction:column;gap:18px}
  .mobile-nav{display:none;align-items:center;gap:6px;padding:10px 16px;border-bottom:1px solid var(--border);background:var(--panel);overflow-x:auto}
  .mobile-nav button,.mobile-nav a{flex:none;border:1px solid var(--border);background:var(--panel);color:var(--ink-2);border-radius:8px;padding:6px 10px;font-size:12px;font-weight:600;white-space:nowrap}
  .mobile-nav button.active{background:var(--accent-soft);border-color:var(--accent);color:var(--ink)}
  .mobile-nav a{color:var(--ink);text-decoration:none}

  @media(max-width:1180px){.tiles{grid-template-columns:repeat(3,minmax(0,1fr))}.grid-2{grid-template-columns:1fr}}
  @media(max-width:900px){.app{grid-template-columns:1fr}.sidebar{display:none}.mobile-nav{display:flex}}
  @media(max-width:720px){.tiles{grid-template-columns:repeat(2,minmax(0,1fr))}.content{padding:16px}}
  @media(max-width:480px){.tiles{grid-template-columns:1fr}}
  @media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style></head>
<body>
<div class="app">
  <aside class="sidebar">
    <div class="brand"><div class="glyph">±</div><div><span class="word">Orvex</span><span class="tag">Review</span></div></div>
    <button class="switcher" onclick="location.href='/dashboard'"><span class="ws-ava" id="wsAvatar">·</span><span class="ws-name"><span id="wsName">…</span><br><span class="ws-slug" id="wsSlug"></span></span></button>
    <nav class="nav" aria-label="Primary">
      <div class="nav-label">Workspace</div>
      <a class="active" data-view="overview">${ico.overview}Overview</a>
      <a data-view="pulls">${ico.pulls}Pull requests <span class="count" id="cPulls"></span></a>
      <a data-view="findings">${ico.findings}Findings <span class="count" id="cFind"></span></a>
      <a data-view="reviews">${ico.reviews}Review runs</a>
      <a data-view="repos">${ico.repos}Repositories <span class="count" id="cRepos"></span></a>
      <a data-view="installs">${ico.installs}Installations</a>
      <a data-view="settings">${ico.settings}Settings</a>
    </nav>
    <div class="side-foot">
      <button class="theme-toggle" id="themeBtn" aria-label="Toggle light and dark theme">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
        <span id="themeLabel">Theme</span><span class="tt-track"><span class="tt-knob"></span></span>
      </button>
      ${isSuperAdmin ? `<a data-nav href="/superadmin" class="nav-link nav" style="display:flex;align-items:center;gap:11px;padding:8px 10px;border-radius:9px;color:var(--ink-2);font-size:13.5px;font-weight:500">${ico.settings}Super admin</a>` : ''}
      <a href="/settings/security" style="display:flex;align-items:center;gap:11px;padding:8px 10px;border-radius:9px;color:var(--ink-2);font-size:13px">Account security</a>
      <a href="/connect" style="display:flex;align-items:center;gap:11px;padding:8px 10px;border-radius:9px;color:var(--ink-2);font-size:13px">Add repositories</a>
      ${logoutCsrf ? `<form method="post" action="/auth/logout" style="margin:0"><input type="hidden" name="csrf" value="${logoutCsrf}" /><button type="submit" style="display:flex;align-items:center;gap:11px;width:100%;padding:8px 10px;border:0;border-radius:9px;background:transparent;color:var(--ink-2);font-size:13px;text-align:left">Sign out</button></form>` : ''}
    </div>
  </aside>

  <div class="main">
    <header class="topbar">
      <div class="page-h"><span class="crumb"><b id="crumbWs">—</b> &nbsp;/&nbsp; <span id="crumbView">Overview</span></span><span class="t" id="viewTitle">Overview</span></div>
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
      <div class="banner" id="legacyBanner" style="display:none">Viewing without login — set <code>GITHUB_OAUTH_CLIENT_ID</code> to require sign-in.</div>
      ${billingBanner}

      <!-- OVERVIEW -->
      <div class="view active" id="v-overview">
        <section class="tiles" id="tiles"><div class="loading">Loading…</div></section>
        <section class="grid-2">
          <div class="panel"><div class="panel-h"><div><h2>Reviews per day</h2><span class="sub">Completed review runs · last 14 days</span></div></div>
            <div class="chart-wrap"><div class="chart" id="chart"><svg viewBox="0 0 640 210" role="img" aria-label="Reviews per day"><g id="gGrid"></g><g id="gBars"></g><g id="gX"></g><g id="gY"></g></svg><div class="tip" id="tip"></div></div></div>
          </div>
          <div class="panel"><div class="panel-h"><div><h2>Findings by severity</h2><span class="sub" id="sevSub">—</span></div><div class="spacer"></div><button class="btn" data-view="findings" style="padding:5px 11px">View all</button></div>
            <div class="sev-panel-body" id="sevBody"></div>
          </div>
        </section>
        <section class="grid-2">
          <div class="panel"><div class="panel-h"><div><h2>Review runs</h2><span class="sub">Latest across the workspace</span></div><div class="spacer"></div><button class="btn" data-view="reviews" style="padding:5px 11px">Open runs →</button></div>
            <div class="table-scroll"><table class="runs"><thead><tr><th>Repository</th><th>PR</th><th>Trigger</th><th>Status</th><th class="r">New</th><th class="r">Duration</th><th class="r">When</th></tr></thead><tbody id="recentBody"></tbody></table></div>
          </div>
          <div class="panel"><div class="panel-h"><div><h2>Deep vs Normal</h2><span class="sub">Completed runs · last 14 days</span></div></div>
            <div class="panel-body" id="deepBody"><div class="loading">Loading…</div></div>
          </div>
        </section>
      </div>

      <!-- PULLS --><div class="view" id="v-pulls"><div class="panel"><div class="panel-h"><div><h2>Pull requests</h2><span class="sub" id="pullSub">—</span></div></div><div class="table-scroll"><table class="runs"><thead><tr><th>Repo</th><th>PR</th><th>State</th><th class="r">Open bugs</th><th class="r">Reviewed</th></tr></thead><tbody id="pullBody"></tbody></table></div></div></div>
      <!-- FINDINGS --><div class="view" id="v-findings"><div class="panel"><div class="panel-h"><div><h2>Findings</h2><span class="sub">Bugs Orvex found, most severe first.</span></div></div><div class="table-scroll"><table class="runs"><thead><tr><th>Sev</th><th>Repo · PR</th><th>File</th><th>Finding</th><th>Status</th></tr></thead><tbody id="findBody"></tbody></table></div></div></div>
      <!-- REVIEWS --><div class="view" id="v-reviews"><div class="panel"><div class="panel-h"><div><h2>Review runs</h2><span class="sub">Every review &amp; fix run, newest first.</span></div></div><div class="table-scroll"><table class="runs"><thead><tr><th>Repo</th><th>PR</th><th>Trigger</th><th>Status</th>${showLlmCost ? '<th class="r">Cost</th>' : ''}<th class="r">Duration</th><th class="r">When</th></tr></thead><tbody id="reviewsBody"></tbody></table></div></div></div>
      <!-- REPOS --><div class="view" id="v-repos"><div class="panel"><div class="panel-h"><div><h2>Repositories</h2><span class="sub">Toggle which repos Orvex reviews.</span></div><div class="spacer"></div><button class="btn" id="syncRepos">Sync from GitHub</button></div><div class="panel-body" id="reposList"><div class="loading">Loading…</div></div></div></div>
      <!-- INSTALLS --><div class="view" id="v-installs"><div class="panel"><div class="panel-h"><div><h2>GitHub installations</h2><span class="sub">Orgs where the Orvex App is installed.</span></div></div><div class="panel-body" id="installs"><div class="loading">Loading…</div></div></div></div>
      <!-- SETTINGS --><div class="view" id="v-settings">
        <div class="panel"><div class="panel-h"><div><h2>Plan and billing</h2><span class="sub">Current plan: ${escapeHtml(planLabel)} · billed per workspace.</span></div></div><div class="panel-body">${canManageBilling
          ? `<button class="btn" onclick="location.href='/#pricing'">View plans</button> <button class="btn" onclick="location.href='/billing/portal/${encodeURIComponent(slug)}'">Manage billing</button> <button class="btn" onclick="location.href='mailto:support@useorvex.com?subject=${encodeURIComponent(`Orvex billing help - ${slug}`)}'">Billing help</button>`
          : '<span class="muted">Only a workspace owner can change the plan or request cancellation.</span>'}<p class="muted" style="margin:12px 0 0;font-size:13px">Your allowance: <strong>${escapeHtml(quotaLine)}</strong>. Comment <code>@orvex rate limit</code> on any PR to see remaining capacity.</p>
          ${plan.overageCentsPerReview != null
            ? `<div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--line,#e5e7eb)"><p style="margin:0 0 8px;font-size:14px"><strong>Prepaid overage wallet:</strong> $${(creditBalanceCents / 100).toFixed(2)} · $${(plan.overageCentsPerReview / 100).toFixed(2)}/review after included quota</p>
          ${canManageBilling
            ? `<p class="muted" style="margin:0 0 10px;font-size:12px">Add money before reviews past your included monthly total. Credits are charged only when a review actually runs.</p>
          <button class="btn" type="button" onclick="buyCredits(1000)">Buy $10</button>
          <button class="btn" type="button" onclick="buyCredits(2500)">Buy $25</button>
          <button class="btn" type="button" onclick="buyCredits(5000)">Buy $50</button>
          <button class="btn" type="button" onclick="buyCredits(10000)">Buy $100</button>`
            : '<p class="muted" style="margin:0;font-size:12px">Ask a workspace owner to add prepaid credits.</p>'}
          </div>`
            : ''}
          </div></div>
        <div class="panel"><div class="panel-h"><div><h2>Account security</h2><span class="sub">Password and authenticator settings.</span></div></div><div class="panel-body"><button class="btn" onclick="location.href='/settings/security'">Manage account security</button></div></div>
        <div class="panel"><div class="panel-h"><div><h2>Privacy and data</h2><span class="sub">Review the policy or request a copy or deletion of workspace data.</span></div></div><div class="panel-body"><button class="btn" onclick="location.href='/privacy'">Privacy policy</button> <button class="btn" onclick="location.href='mailto:support@useorvex.com?subject=${encodeURIComponent(`Orvex data request - ${slug}`)}'">Request data help</button></div></div>
        <div class="panel"><div class="panel-h"><div><h2>Automatic review triggers</h2><span class="sub">Per repo. <code>@orvex review</code> always works regardless.</span></div></div><div class="panel-body" id="settingsList"><div class="loading">Loading…</div></div></div>
        <div class="panel"><div class="panel-h"><div><h2>GitHub commands</h2><span class="sub">Comment these on a pull request. Same list as <code>@orvex help</code>.</span></div></div><div class="panel-body">
          <p class="muted" style="margin:0 0 12px;font-size:13px;line-height:1.55">Orvex reviews when a PR opens and (if enabled above) on each push. Manual commands always work. A standard review uses <strong>1</strong> unit; <code>@orvex deep</code> uses <strong>2</strong>. Skipped reviews and fix/explain commands do not consume units; failed reviews still count toward free-trial and hourly caps. Tick <strong>Apply this fix</strong> on an inline finding to commit that one fix.</p>
          <div class="table-scroll"><table class="runs"><thead><tr><th>Command</th><th>Where</th><th>Effect</th></tr></thead><tbody>${commandRows}</tbody></table></div>
          <p class="muted" style="margin:12px 0 0;font-size:12px;line-height:1.5">Need the list on a PR? Comment <code>@orvex help</code>. Check quota without starting a review: <code>@orvex rate limit</code>.</p>
        </div></div>
      </div>
    </div>
  </div>
</div>
<script>
const SLUG=${s};
const SHOW_LLM_COST=${showLlmCost ? 'true' : 'false'};
const api=(p)=>fetch('/api/workspaces/'+encodeURIComponent(SLUG)+p,{credentials:'same-origin'}).then(r=>r.ok?r.json():r.json().then(e=>Promise.reject(e)));
async function buyCredits(amountCents){
  try{
    const r=await fetch('/api/workspaces/'+encodeURIComponent(SLUG)+'/billing/credits',{
      method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},
      body:JSON.stringify({amountCents})
    });
    const body=await r.json().catch(()=>({}));
    if(!r.ok){alert(body.error||'Could not start credit checkout');return;}
    if(body.url) location.href=body.url; else alert('Stripe did not return a checkout URL');
  }catch(e){alert('Could not start credit checkout');}
}
const esc=(x)=>String(x==null?'':x).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const sevCls=(s)=>({P1:'p1',P2:'p2',P3:'p3'}[s]||'muted');
const runCls=(s)=>s==='completed'?'done':s==='failed'?'fail':s==='running'?'run':'queued';
const runReason=(r)=>r.skipReason==='pr_closed_mid_run'?'PR closed during review':r.skipReason==='provider_not_configured'?'Provider unavailable':r.skipReason?String(r.skipReason).replaceAll('_',' '):r.status==='failed'?'No verdict — retry':'';
const runChip=(s,reason)=>'<span class="chip '+runCls(s)+'"'+(reason?' title="'+esc(reason)+'"':'')+'><span class="cd"></span>'+esc(s[0].toUpperCase()+s.slice(1))+(reason?' <small>'+esc(reason)+'</small>':'')+'</span>';
const rel=(iso)=>{if(!iso)return'—';const d=(Date.now()-new Date(iso).getTime())/1000;if(d<60)return'just now';if(d<3600)return Math.floor(d/60)+'m ago';if(d<86400)return Math.floor(d/3600)+'h ago';return Math.floor(d/86400)+'d ago';};
const dur=(ms)=>{if(!ms)return'—';const sec=Math.round(ms/1000);return sec<60?sec+'s':Math.floor(sec/60)+'m '+String(sec%60).padStart(2,'0')+'s';};
const usd=(n)=>n==null?'—':'$'+Number(n).toFixed(2);
const repoShort=(fn)=>String(fn||'').split('/');

// —— theme toggle (persisted) ——
(function(){const root=document.documentElement,btn=document.getElementById('themeBtn'),lab=document.getElementById('themeLabel');
  const sysDark=()=>window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches;
  const eff=()=>{const t=root.getAttribute('data-theme');return t==='dark'?true:t==='light'?false:sysDark();};
  const sync=()=>{const d=eff();root.classList.toggle('is-dark',d);if(lab)lab.textContent=d?'Dark':'Light';};
  btn.addEventListener('click',()=>{const next=eff()?'light':'dark';root.setAttribute('data-theme',next);try{localStorage.setItem('orvex-theme',next);}catch(e){}sync();});
  window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change',()=>{if(!root.getAttribute('data-theme'))sync();});
  sync();
})();

document.getElementById('wsName').textContent=SLUG; document.getElementById('wsSlug').textContent=SLUG;
document.getElementById('wsAvatar').textContent=SLUG.slice(0,1).toUpperCase();
document.getElementById('avatar').textContent=SLUG.slice(0,1).toUpperCase();
document.getElementById('crumbWs').textContent=SLUG;
document.getElementById('refresh').onclick=loadAll;

const titles={overview:'Overview',pulls:'Pull requests',findings:'Findings',reviews:'Review runs',repos:'Repositories',installs:'Installations',settings:'Settings'};
function showView(v){
  document.querySelectorAll('.nav a[data-view],.mobile-nav button[data-view]').forEach(x=>x.classList.toggle('active',x.dataset.view===v));
  document.querySelectorAll('.view').forEach(x=>x.classList.remove('active'));
  document.getElementById('v-'+v).classList.add('active');
  document.getElementById('viewTitle').textContent=titles[v];
  document.getElementById('crumbView').textContent=titles[v];
  if(v==='repos')loadRepos(); if(v==='reviews')loadReviews(); if(v==='settings')loadSettings(); if(v==='installs')loadInstalls();
}
document.querySelectorAll('[data-view]').forEach(b=>b.addEventListener('click',()=>showView(b.dataset.view)));

// —— sparkline ——
function spark(vals,color){
  if(!vals.length)vals=[0,0];
  const W=120,H=34,max=Math.max(1,...vals),min=Math.min(...vals),span=Math.max(1,max-min);
  const pts=vals.map((v,i)=>{const x=vals.length>1?i/(vals.length-1)*W:W;const y=H-4-((v-min)/span)*(H-8);return x.toFixed(1)+','+y.toFixed(1);});
  const last=pts[pts.length-1].split(',');
  return '<svg viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="none" aria-hidden="true"><polyline points="'+pts.join(' ')+'" fill="none" stroke="'+color+'" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="'+last[0]+'" cy="'+last[1]+'" r="2.6" fill="'+color+'"/></svg>';
}
function deltaEl(cur,prev,unit,invert){
  if(prev===0&&cur===0)return '<span class="delta flat">±0</span>';
  const diff=cur-prev; const good=invert?diff<0:diff>0;
  const cls=diff===0?'flat':good?'up':'down'; const arrow=diff===0?'±':diff>0?'▲':'▼';
  const mag=unit==='%'?Math.abs(prev?Math.round((diff/Math.max(1,prev))*100):0)+'%':Math.abs(diff);
  return '<span class="delta '+cls+'">'+arrow+' '+mag+'</span>';
}

// —— per-day series from real review runs ——
let seriesCache=null;
async function series(){
  if(seriesCache)return seriesCache;
  const {reviews}=await api('/reviews?limit=300');
  const days=[]; const idx={};
  for(let i=13;i>=0;i--){const d=new Date(Date.now()-i*86400000);const key=d.toISOString().slice(0,10);idx[key]=days.length;days.push({key,label:d.toLocaleDateString(undefined,{month:'short',day:'numeric'}),reviews:0,bugs:0,cost:0,durSum:0,durN:0});}
  reviews.forEach(r=>{const k=(r.createdAt||'').slice(0,10);if(!(k in idx))return;const d=days[idx[k]];
    if(r.status==='completed'){d.reviews++;d.bugs+=r.findingsNew||0;d.cost+=r.costUsd||0;if(r.durationMs){d.durSum+=r.durationMs;d.durN++;}}});
  seriesCache={days,all:reviews};
  return seriesCache;
}
const half=(arr,f)=>({prev:arr.slice(0,7).reduce((a,d)=>a+f(d),0),cur:arr.slice(7).reduce((a,d)=>a+f(d),0)});

async function loadAll(){
  seriesCache=null; reviewsLoaded=reposLoaded=settingsLoaded=false;
  try{
    const o=await api('/overview');
    document.getElementById('cFind').textContent=o.findings.open||'';
    document.getElementById('cPulls').textContent=o.pullRequests.open||'';
    document.getElementById('cRepos').textContent=(o.repos||[]).filter(r=>r.enabled).length||'';
    await tiles(o); severity(o.findings);
  }catch(e){document.getElementById('tiles').innerHTML='<div class="empty">'+esc(e.error||'Failed to load — try signing in again')+'</div>';return;}
  loadRecent(); loadDeep(); loadPulls(); loadFindings();
}
async function tiles(o){
  const s=o.stats,f=o.findings; const {days}=await series();
  const total=(f.open||0)+(f.fixed||0), rate=total?Math.round(f.fixed/total*100):0;
  const avg=s.avgDurationMs?dur(s.avgDurationMs):'—';
  const by=f.bySeverity||{}; const sev=[['P1',by.P1||0,'var(--p1)'],['P2',by.P2||0,'var(--p2)'],['P3',by.P3||0,'var(--p3)'],['Info',by.info||0,'var(--info)']];
  const sevTot=Math.max(1,sev.reduce((a,x)=>a+x[1],0));
  const rv=half(days,d=>d.reviews), bg=half(days,d=>d.bugs);
  const t=(icon,label,val,body)=>'<div class="tile"><div class="tl">'+icon+esc(label)+'</div><div class="big">'+val+'</div>'+body+'</div>';
  const cap=(d,c)=>'<div class="foot">'+d+'<span class="cap">'+c+'</span></div>';
  const tileList=[
    t('<svg class="ti" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4v6h6"/><path d="M4 10a8 8 0 1 1 2.3 5.6"/></svg>','Reviews · 14d','<span class="num">'+(s.runsCompleted??0)+'</span>',
      '<div class="spark">'+spark(days.map(d=>d.reviews),'var(--accent)')+'</div>'+cap(deltaEl(rv.cur,rv.prev),'vs prev 7d')),
    t('<svg class="ti" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l9 16H3z"/><path d="M12 10v4"/><path d="M12 17h.01"/></svg>','Bugs caught · 14d','<span class="num">'+(s.findingsNew??0)+'</span>',
      '<div class="spark">'+spark(days.map(d=>d.bugs),'var(--good)')+'</div>'+cap(deltaEl(bg.cur,bg.prev),'vs prev 7d')),
    t('<svg class="ti" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l9 16H3z"/><path d="M12 10v4"/></svg>','Open findings','<span class="num">'+(f.open??0)+'</span>',
      '<div class="sevsplit">'+sev.map(x=>'<span style="width:'+(x[1]/sevTot*100)+'%;background:'+x[2]+'"></span>').join('')+'</div><div class="sevkeys">'+sev.slice(0,3).map(x=>'<span><i style="background:'+x[2]+'"></i>'+x[0]+' <b class="num">'+x[1]+'</b></span>').join('')+'</div>'),
    t('<svg class="ti" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>','Avg review time',esc(avg),
      '<div class="spark">'+spark(days.map(d=>d.durN?d.durSum/d.durN/1000:0),'var(--p3)')+'</div>'+cap('<span class="delta flat">'+rate+'%</span>','fix rate')),
  ];
  if(SHOW_LLM_COST){const ct=half(days,d=>d.cost);tileList.push(
    t('<svg class="ti" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v10M9.5 9.2A2.4 2 0 0 1 12 8c1.5 0 2.3.8 2.3 1.7s-.8 1.6-2.3 1.9-2.3 1-2.3 1.9.9 1.7 2.3 1.7a2.4 2 0 0 0 2.5-1.2"/></svg>','LLM cost · 14d','<small>$</small><span class="num">'+Number(s.costUsd||0).toFixed(2)+'</span>',
      '<div class="spark">'+spark(days.map(d=>d.cost),'var(--p2)')+'</div>'+cap(deltaEl(Number(ct.cur.toFixed(2)),Number(ct.prev.toFixed(2)),'',true),'vs prev 7d'))
  );}
  document.getElementById('tiles').innerHTML=tileList.join('');
}
function severity(f){
  const by=f.bySeverity||{},max=Math.max(1,by.P1||0,by.P2||0,by.P3||0,by.info||0);
  document.getElementById('sevSub').textContent=(f.open||0)+' open across all repos';
  const rows=[['P1 · Critical','var(--p1)',by.P1||0],['P2 · High','var(--p2)',by.P2||0],['P3 · Medium','var(--p3)',by.P3||0],['Low · info','var(--info)',by.info||0]];
  let html=rows.map(([n,c,v])=>'<div class="sevbar-row"><span class="lbl"><i style="background:'+c+'"></i>'+n+'</span><span class="sevbar-track"><span class="sevbar-fill" style="transform:scaleX('+((v/max)||0)+');background:'+c+'"></span></span><span class="cnt num" style="color:'+c+'">'+v+'</span></div>').join('');
  if((f.fixed||0)>0)html+='<div class="sev-foot"><span class="chk"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg></span><span><b>'+f.fixed+' fixed</b> — Orvex committed the fix and closed them.</span></div>';
  document.getElementById('sevBody').innerHTML=html;
}
async function loadRecent(skipChart){
  try{const {days,all}=await series();const b=document.getElementById('recentBody');const recent=all.slice().reverse().slice(0,7);
    b.innerHTML=recent.length?recent.map(r=>{const[org,name]=repoShort(r.repo?r.owner+'/'+r.repo:'');return '<tr><td class="repo mono"><span class="org">'+esc((r.owner||'')+'/')+'</span>'+esc(r.repo||'')+'</td><td class="mono">#'+r.pr+'</td><td>'+trigCell(r)+'</td><td>'+runChip(r.status,runReason(r))+'</td><td class="r num">'+(r.findingsNew||0)+'</td><td class="r mono">'+(r.status==='running'?'…':dur(r.durationMs))+'</td><td class="r mono">'+rel(r.createdAt)+'</td></tr>';}).join(''):'<tr><td colspan="7" class="empty">No reviews yet.</td></tr>';
    if(!skipChart)drawChart(days);
  }catch{if(!skipChart)drawChart([]);}
}
function trigCell(r){
  // Map the raw webhook/job action to a clear "what triggered this" label so runs
  // are distinguishable: manual (@orvex review) vs auto-on-PR-open vs auto-on-commit.
  const M={opened:['Auto · PR opened','auto'],reopened:['Auto · PR reopened','auto'],synchronize:['Auto · new commit','commit'],command:['Manual','manual'],manual:['Manual (API)','manual']};
  const e=M[r.action]||[r.action||'review','auto'];
  const label=r.deep?e[0]+' · deep':e[0];
  return '<span class="trig '+e[1]+(r.deep?' deep':'')+'" title="'+esc((r.action||'')+(r.deep?' (deep pass)':''))+'"><span class="tdot"></span>'+esc(label)+'</span>';
}
async function loadDeep(){
  try{const {days,all}=await series();const done=all.filter(r=>r.status==='completed');
    const deep=done.filter(r=>r.deep),norm=done.filter(r=>!r.deep);
    if(!SHOW_LLM_COST){
      document.getElementById('deepBody').innerHTML='<div class="dvn-grid"><div class="dvn-card"><div class="k"><i></i>Normal</div><div class="runs num">'+norm.length+' <small>runs</small></div></div><div class="dvn-card deep"><div class="k"><i></i>Deep</div><div class="runs num">'+deep.length+' <small>runs</small></div></div></div>';
      return;
    }
    const avg=(a)=>a.length?a.reduce((s,r)=>s+(r.costUsd||0),0)/a.length:0;
    const na=avg(norm),da=avg(deep);
    const deepBugs=deep.length?deep.reduce((s,r)=>s+(r.findingsNew||0),0)/deep.length:0;
    const normBugs=norm.length?norm.reduce((s,r)=>s+(r.findingsNew||0),0)/norm.length:0;
    let html='<div class="dvn-grid"><div class="dvn-card"><div class="k"><i></i>Normal</div><div class="runs num">'+norm.length+' <small>runs</small></div><div class="avg">avg <b>'+usd(na)+'</b> / review</div></div>'+
      '<div class="dvn-card deep"><div class="k"><i></i>Deep</div><div class="runs num">'+deep.length+' <small>runs</small></div><div class="avg">avg <b>'+usd(da)+'</b> / review</div></div></div>';
    if(deep.length&&norm.length){const more=(deepBugs-normBugs);html+='<div class="sev-foot" style="background:var(--p2-soft);color:var(--ink);margin-top:14px"><span class="chk" style="background:var(--p2)"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l9 16H3z" opacity="0"/><path d="M5 12h14"/></svg></span><span>Deep surfaced <b>'+(more>0?'+'+more.toFixed(1):more.toFixed(1))+' findings/PR</b> more than normal, for ~'+usd(da-na)+' extra.</span></div>';}
    else if(!deep.length)html+='<div class="empty" style="margin-top:12px">No deep runs yet. Comment <code>@orvex deep</code> on a PR to run extra passes.</div>';
    document.getElementById('deepBody').innerHTML=html;
  }catch(e){document.getElementById('deepBody').innerHTML='<div class="empty">'+esc(e.error||'error')+'</div>';}
}
// live refresh so a running row flips to completed without a manual reload
setInterval(()=>{if(document.getElementById('v-overview').classList.contains('active')){seriesCache=null;loadRecent(true);}
  else if(document.getElementById('v-reviews').classList.contains('active')){reviewsLoaded=false;loadReviews();}},6000);

function drawChart(days){
  const ns='http://www.w3.org/2000/svg',W=640,H=210,pL=30,pR=10,pT=12,pB=26,pw=W-pL-pR,ph=H-pT-pB;
  const el=(t,a)=>{const e=document.createElementNS(ns,t);for(const k in a)e.setAttribute(k,a[k]);return e;};
  ['gGrid','gBars','gX','gY'].forEach(id=>document.getElementById(id).innerHTML='');
  if(!days.length)return;
  const data=days.map(d=>({label:d.label,v:d.reviews}));
  const max=Math.max(4,...data.map(d=>d.v)),n=data.length,slot=pw/n,bw=Math.min(26,slot*0.62);
  const y=v=>pT+ph-(v/max)*ph;
  const g=document.getElementById('gGrid'),bars=document.getElementById('gBars'),gx=document.getElementById('gX'),gy=document.getElementById('gY'),tip=document.getElementById('tip'),svg=document.querySelector('#chart svg');
  [0,Math.round(max/2),max].forEach(tk=>{g.appendChild(el('line',{x1:pL,x2:W-pR,y1:y(tk),y2:y(tk),stroke:'var(--grid)','stroke-width':1}));const lb=el('text',{x:pL-7,y:y(tk)+3,'text-anchor':'end','font-size':10,fill:'var(--ink-3)','font-family':'var(--mono)'});lb.textContent=tk;gy.appendChild(lb);});
  data.forEach((pt,i)=>{const cx=pL+slot*i+slot/2,bh=(pt.v/max)*ph,grp=el('g',{class:'bar-group'});
    grp.appendChild(el('rect',{class:'bar-rect',x:cx-bw/2,y:y(pt.v),width:bw,height:Math.max(bh,1),fill:'var(--accent)',rx:3}));
    grp.appendChild(el('rect',{x:pL+slot*i,y:pT,width:slot,height:ph,fill:'transparent'}));
    grp.addEventListener('mousemove',()=>{const box=svg.getBoundingClientRect();tip.innerHTML=pt.label+' · <strong>'+pt.v+'</strong>';tip.style.left=(cx*box.width/W)+'px';tip.style.top=(y(pt.v)*box.height/H)+'px';tip.style.opacity='1';});
    grp.addEventListener('mouseleave',()=>tip.style.opacity='0');
    bars.appendChild(grp);
    if(i%2===1){const xl=el('text',{x:cx,y:H-8,'text-anchor':'middle','font-size':10,fill:'var(--ink-3)'});xl.textContent=pt.label;gx.appendChild(xl);}
  });
}
async function loadPulls(){
  try{const {pulls,counts}=await api('/pulls?limit=100');
    document.getElementById('pullSub').textContent=counts.open+' open · '+counts.merged+' merged · '+counts.closed+' closed';
    const b=document.getElementById('pullBody');
    b.innerHTML=pulls.length?pulls.map(p=>'<tr><td class="mono">'+esc(repoShort(p.repoFullName).pop())+'</td><td><span class="pr-t mono">#'+p.number+' '+esc(p.title||'')+'</span></td><td><span class="chip '+(p.state==='merged'?'p3':p.state==='closed'?'muted':'ok')+'"><span class="cd"></span>'+esc(p.state)+'</span></td><td class="r">'+(p.openFindings>0?'<span class="chip p2">'+p.openFindings+'</span>':'<span class="chip ok">0</span>')+'</td><td class="r mono">'+rel(p.lastReviewedAt)+'</td></tr>').join(''):'<tr><td colspan="5" class="empty">No pull requests recorded yet.</td></tr>';
  }catch(e){document.getElementById('pullBody').innerHTML='<tr><td colspan="5" class="empty">'+esc(e.error||'error')+'</td></tr>';}
}
async function loadFindings(){
  try{const {findings}=await api('/findings?limit=100');const b=document.getElementById('findBody');
    b.innerHTML=findings.length?findings.map(f=>'<tr><td><span class="chip '+sevCls(f.severity)+'">'+esc(f.severity)+'</span></td><td class="mono">'+esc(repoShort(f.repoFullName).pop())+' #'+f.prNumber+'</td><td class="mono">'+esc(repoShort(f.file).pop())+(f.line?':'+f.line:'')+'</td><td><span class="pr-t">'+esc((f.message||'').slice(0,90))+'</span></td><td><span class="chip '+(f.status==='fixed'?'ok':f.status==='ignored'?'muted':'p2')+'">'+esc(f.status)+(f.status==='fixed'&&f.fixedAtSha?' '+f.fixedAtSha.slice(0,7):'')+'</span></td></tr>').join(''):'<tr><td colspan="5" class="empty">No findings yet.</td></tr>';
  }catch(e){document.getElementById('findBody').innerHTML='<tr><td colspan="5" class="empty">'+esc(e.error||'error')+'</td></tr>';}
}
let reviewsLoaded=false;
async function loadReviews(){if(reviewsLoaded)return;reviewsLoaded=true;
  try{const {reviews}=await api('/reviews?limit=100');const b=document.getElementById('reviewsBody');
    const cols=SHOW_LLM_COST?7:6;
    b.innerHTML=reviews.length?reviews.slice().reverse().map(r=>'<tr><td class="repo mono"><span class="org">'+esc((r.owner||'')+'/')+'</span>'+esc(r.repo||'')+'</td><td class="mono">#'+r.pr+'</td><td>'+trigCell(r)+'</td><td>'+runChip(r.status,runReason(r))+'</td>'+(SHOW_LLM_COST?'<td class="r mono">'+usd(r.costUsd)+'</td>':'')+'<td class="r mono">'+(r.status==='running'?'…':dur(r.durationMs))+'</td><td class="r mono">'+rel(r.createdAt)+'</td></tr>').join(''):'<tr><td colspan="'+cols+'" class="empty">No review runs yet.</td></tr>';
  }catch(e){document.getElementById('reviewsBody').innerHTML='<tr><td colspan="'+(SHOW_LLM_COST?7:6)+'" class="empty">'+esc(e.error||'error')+'</td></tr>';}
}
let reposLoaded=false;
document.getElementById('syncRepos').onclick=async()=>{const b=document.getElementById('syncRepos');b.disabled=true;b.textContent='Syncing…';try{const r=await fetch('/api/workspaces/'+encodeURIComponent(SLUG)+'/repos/sync',{method:'POST',credentials:'same-origin'});if(!r.ok)throw await r.json().catch(()=>({error:'sync failed'}));reposLoaded=false;await loadRepos();b.textContent='Synced';}catch(e){b.textContent=e.error||'Sync failed';}finally{setTimeout(()=>{b.disabled=false;b.textContent='Sync from GitHub';},1800);}};
async function loadRepos(){if(reposLoaded)return;reposLoaded=true;const list=document.getElementById('reposList');
  try{const {repos}=await api('/repos');
    list.innerHTML=repos.length?repos.map(r=>'<div class="repo-row"><span class="rn">'+esc(r.fullName)+'</span><span class="rm"><span class="muted" style="font-size:12px">'+(r.private?'private':'public')+'</span><button class="toggle" role="switch" aria-checked="'+r.enabled+'" data-id="'+r.id+'"></button></span></div>').join(''):'<div class="empty">No repositories. Click “Add repositories”.</div>';
    list.querySelectorAll('.toggle').forEach(t=>t.onclick=()=>toggleRepo(t));
  }catch(e){list.innerHTML='<div class="empty">'+esc(e.error||'error')+'</div>';}
}
async function toggleRepo(t){const next=t.getAttribute('aria-checked')!=='true';t.setAttribute('aria-checked',next);
  try{await fetch('/api/workspaces/'+encodeURIComponent(SLUG)+'/repos/'+t.dataset.id,{method:'PATCH',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({enabled:next})}).then(r=>{if(!r.ok)throw 0;});}catch{t.setAttribute('aria-checked',!next);}
}
let settingsLoaded=false;
async function loadSettings(){if(settingsLoaded)return;settingsLoaded=true;const list=document.getElementById('settingsList');
  try{const {repos}=await api('/repos');
    list.innerHTML=repos.length?repos.map(r=>'<div class="settings-row"><div class="sr-head"><span class="rn">'+esc(r.fullName)+'</span>'+(r.enabled?'':'<span class="chip muted">repo disabled</span>')+'</div><div class="sr-toggles">'+
      '<label class="sr-toggle"><button class="toggle" role="switch" aria-checked="'+r.reviewOnOpen+'" data-id="'+r.id+'" data-field="reviewOnOpen"></button><span><strong>Run on each PR</strong><br><span class="muted" style="font-size:12px">Auto-review when a pull request is opened (or reopened)</span></span></label>'+
      '<label class="sr-toggle"><button class="toggle" role="switch" aria-checked="'+r.reviewOnPush+'" data-id="'+r.id+'" data-field="reviewOnPush"></button><span><strong>Run on each commit</strong><br><span class="muted" style="font-size:12px">Auto-review again on every new push to an open PR</span></span></label>'+
      '</div></div>').join(''):'<div class="empty">No repositories. Click “Add repositories”.</div>';
    list.querySelectorAll('.toggle').forEach(t=>t.onclick=()=>toggleSetting(t));
  }catch(e){list.innerHTML='<div class="empty">'+esc(e.error||'error')+'</div>';}
}
async function toggleSetting(t){const next=t.getAttribute('aria-checked')!=='true';t.setAttribute('aria-checked',next);
  try{await fetch('/api/workspaces/'+encodeURIComponent(SLUG)+'/repos/'+t.dataset.id,{method:'PATCH',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({[t.dataset.field]:next})}).then(r=>{if(!r.ok)throw 0;});}catch{t.setAttribute('aria-checked',!next);}
}
let installsLoaded=false;
async function loadInstalls(){if(installsLoaded)return;installsLoaded=true;
  try{const {installations}=await api('/installations');const el=document.getElementById('installs');
    el.innerHTML=installations.length?installations.map(i=>'<div class="install-row"><span class="ws-ava" style="width:30px;height:30px;border-radius:8px">'+esc((i.account||'?').slice(0,2).toUpperCase())+'</span><div><div class="org">'+esc(i.account)+' <span class="chip '+(i.suspended?'p2':'ok')+'" style="margin-left:6px"><span class="cd"></span>'+(i.suspended?'Suspended':'Active')+'</span></div><div class="meta">'+esc(i.accountType)+' · '+esc(i.repositorySelection)+' · #'+i.installationId+'</div></div><div class="right"><button class="ghost" onclick="location.href=\\'/connect\\'">Configure</button></div></div>').join(''):'<div class="empty">No installations.</div>';
  }catch(e){document.getElementById('installs').innerHTML='<div class="empty">'+esc(e.error||'error')+'</div>';}
}
loadAll();
</script>
</body></html>`;
}
