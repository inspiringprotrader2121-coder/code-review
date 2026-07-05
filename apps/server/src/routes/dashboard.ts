import { Hono } from 'hono';
import { createAppDatabase } from '@orvex-review/store';
import { legacyAuthMode } from '@orvex-review/tenants';
import { sessionUser } from './session.js';

export function dashboardRoutes() {
  const app = new Hono();
  const db = createAppDatabase();

  app.get('/dashboard', (c) => {
    if (legacyAuthMode()) {
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
    if (!legacyAuthMode()) {
      const user = sessionUser(c, db);
      if (!user) return c.redirect(`/auth/login?next=/dashboard/${encodeURIComponent(slug)}`);
      const tenant = db.getTenantBySlug(slug);
      if (!tenant || !db.getMembership(tenant.id, user.id)) return c.redirect('/dashboard');
    }
    return c.html(dashboardHtml(slug));
  });

  return app;
}

function dashboardHtml(slug: string): string {
  // JSON.stringify alone leaves `</script>` intact — escape for an inline <script> sink
  const s = JSON.stringify(slug)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Orvex Review — Dashboard</title>
<style>
  :root {
    --page:#f4f4f7; --surface:#fff; --surface-2:#ececf1; --ink:#17181f; --ink-2:#55575f;
    --ink-3:#86888f; --border:rgba(23,24,31,.12); --border-soft:rgba(23,24,31,.07);
    --accent:#4f58d6; --accent-ink:#3d45b8; --accent-wash:rgba(79,88,214,.09);
    --good:#0b7c2a; --good-wash:rgba(12,163,12,.10); --warn:#8a5c00; --warn-wash:rgba(250,178,25,.16);
    --crit:#b32f2f; --crit-wash:rgba(208,59,59,.10); --grid:#e3e3e9; --bar:#4f58d6; --btn-ink:#fff;
    --shadow:0 1px 2px rgba(23,24,31,.05),0 8px 28px rgba(23,24,31,.06);
    --mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
    --body:system-ui,-apple-system,"Segoe UI",sans-serif;
    --display:"Avenir Next",Avenir,Seravek,system-ui,sans-serif;
  }
  @media (prefers-color-scheme:dark){:root{
    --page:#0e0f14; --surface:#171821; --surface-2:#1f2029; --ink:#f0f0f4; --ink-2:#b4b6c1;
    --ink-3:#797b87; --border:rgba(240,240,244,.12); --border-soft:rgba(240,240,244,.07);
    --accent:#99a2ff; --accent-ink:#b1b8ff; --accent-wash:rgba(153,162,255,.11);
    --good:#4fc06a; --good-wash:rgba(12,163,12,.16); --warn:#e5a93d; --warn-wash:rgba(250,178,25,.13);
    --crit:#e66767; --crit-wash:rgba(230,103,103,.13); --grid:#262732; --bar:#99a2ff; --btn-ink:#14151c;
    --shadow:0 1px 2px rgba(0,0,0,.35),0 10px 32px rgba(0,0,0,.35);
  }}
  *{box-sizing:border-box} html,body{margin:0;padding:0}
  body{background:var(--page);color:var(--ink);font-family:var(--body);font-size:15px;line-height:1.55;-webkit-font-smoothing:antialiased}
  h1,h2,h3{font-family:var(--display);margin:0} a{color:var(--accent-ink);text-decoration:none}
  button{font:inherit;cursor:pointer} code{font-family:var(--mono);font-size:.9em}
  :focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px}
  .avatar{width:20px;height:20px;border-radius:6px;background:var(--accent);color:var(--btn-ink);font-family:var(--mono);font-size:10px;font-weight:700;display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto}
  .chip{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px;white-space:nowrap}
  .chip .dot{width:6px;height:6px;border-radius:50%;background:currentColor}
  .chip.p1{color:var(--crit);background:var(--crit-wash)} .chip.p2{color:var(--warn);background:var(--warn-wash)}
  .chip.p3{color:var(--accent-ink);background:var(--accent-wash)} .chip.ok{color:var(--good);background:var(--good-wash)}
  .chip.info{color:var(--accent-ink);background:var(--accent-wash)} .chip.muted{color:var(--ink-3);background:var(--surface-2)}
  @media (prefers-reduced-motion: no-preference){.chip.info .dot{animation:pulse 1.2s ease-in-out infinite}@keyframes pulse{50%{opacity:.3}}}
  .dash{display:grid;grid-template-columns:224px 1fr;min-height:100vh}
  @media(max-width:900px){.dash{grid-template-columns:1fr}.sidebar{display:none}}
  .sidebar{background:var(--surface);border-right:1px solid var(--border-soft);padding:18px 14px;display:flex;flex-direction:column;gap:4px}
  .brand{display:flex;align-items:center;gap:9px;font-family:var(--display);font-weight:700;font-size:15px;padding:2px 6px 10px}
  .brand .mark{width:24px;height:24px;border-radius:7px;background:var(--accent);color:var(--btn-ink);font-family:var(--mono);font-weight:700;display:inline-flex;align-items:center;justify-content:center}
  .ws{display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid var(--border);border-radius:10px;margin-bottom:12px;background:var(--page)}
  .ws .avatar{border-radius:8px;width:24px;height:24px;font-size:11px}
  .ws .meta{line-height:1.2;min-width:0} .ws .meta .n1{font-weight:650;font-size:13px} .ws .meta .n2{font-size:11px;color:var(--ink-3);font-family:var(--mono)}
  .navlbl{font-size:10.5px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--ink-3);padding:12px 10px 5px}
  .navitem{display:flex;align-items:center;gap:10px;padding:7px 10px;border-radius:8px;color:var(--ink-2);font-size:13.5px;font-weight:500;border:0;background:none;text-align:left;width:100%;cursor:pointer}
  .navitem:hover{background:var(--surface-2)} .navitem.active{background:var(--accent-wash);color:var(--accent-ink);font-weight:650}
  .navitem .ico{width:17px;text-align:center;opacity:.85} .navitem .count{margin-left:auto;font-size:11px;font-family:var(--mono);color:var(--ink-3)}
  .sidebar .spacer{flex:1}
  .main{padding:22px 28px 60px;min-width:0}
  .topbar{display:flex;align-items:center;gap:14px;margin-bottom:22px;flex-wrap:wrap}
  .topbar h2{font-size:20px;font-weight:700;letter-spacing:-.01em} .topbar .crumb{color:var(--ink-3);font-size:13px}
  .topbar .right{margin-left:auto;display:flex;gap:10px;align-items:center}
  .btn{border:1px solid var(--border);background:var(--surface);color:var(--ink);border-radius:8px;padding:7px 13px;font-size:12.5px;font-weight:600}
  .btn.primary{background:var(--accent);border-color:var(--accent);color:var(--btn-ink)}
  .tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:16px}
  @media(max-width:1100px){.tiles{grid-template-columns:repeat(2,1fr)}} @media(max-width:560px){.tiles{grid-template-columns:1fr}}
  .tile{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:15px 17px}
  .tile .lbl{font-size:12px;color:var(--ink-2);font-weight:550}
  .tile .val{font-size:27px;font-weight:700;font-family:var(--display);letter-spacing:-.01em;margin:3px 0 2px}
  .tile .delta{font-size:12px;color:var(--ink-3)} .tile .delta .up{color:var(--good);font-weight:650}
  .grid2{display:grid;grid-template-columns:1.6fr 1fr;gap:14px;margin-bottom:16px} @media(max-width:1100px){.grid2{grid-template-columns:1fr}}
  .panel{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:17px 18px;min-width:0;margin-bottom:16px}
  .panel h3{font-size:14px;font-weight:650;margin-bottom:3px} .panel .sub{font-size:12px;color:var(--ink-3);margin:0 0 14px}
  .chart{position:relative} .chart svg{display:block;width:100%;height:auto}
  .chart .tip{position:absolute;pointer-events:none;z-index:5;background:var(--ink);color:var(--page);font-size:11.5px;padding:6px 9px;border-radius:7px;transform:translate(-50%,-110%);white-space:nowrap;opacity:0;transition:opacity .1s}
  .chart .tip strong{font-family:var(--mono)}
  .sev-rows{display:grid;gap:13px}
  .sev-row{display:grid;grid-template-columns:110px 1fr 34px;gap:10px;align-items:center}
  .sev-row .name{display:flex;align-items:center;gap:7px;font-size:12.5px;font-weight:600} .sev-row .sq{width:9px;height:9px;border-radius:3px;flex:0 0 auto}
  .sev-row .track{height:9px;background:var(--surface-2);border-radius:5px;overflow:hidden} .sev-row .fill{height:100%;border-radius:5px;transition:width .6s cubic-bezier(.22,1,.36,1)}
  .sev-row .num{font-family:var(--mono);font-size:12px;text-align:right;color:var(--ink-2)}
  .tbl-wrap{overflow-x:auto}
  table.reviews{border-collapse:collapse;width:100%;font-size:13px}
  table.reviews th{text-align:left;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-3);padding:8px 12px;border-bottom:1px solid var(--border)}
  table.reviews td{padding:10px 12px;border-bottom:1px solid var(--border-soft);vertical-align:middle} table.reviews tr:last-child td{border-bottom:0}
  table.reviews tbody tr:hover{background:var(--surface-2)} table.reviews .repo{font-weight:600}
  table.reviews .pr-t{color:var(--ink-2);max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  table.reviews .mono{font-family:var(--mono);font-size:12px;color:var(--ink-2)} table.reviews .num{font-variant-numeric:tabular-nums;text-align:right}
  .installs{display:grid;gap:10px}
  .install-row{display:flex;align-items:center;gap:12px;padding:11px 13px;border:1px solid var(--border);border-radius:10px}
  .install-row .org{font-weight:650;font-size:13.5px} .install-row .meta{font-size:12px;color:var(--ink-3);font-family:var(--mono)}
  .install-row .right{margin-left:auto;display:flex;align-items:center;gap:10px}
  .ghost{border:1px solid var(--border);background:transparent;color:var(--ink-2);border-radius:7px;padding:5px 11px;font-size:12px;font-weight:600} .ghost:hover{border-color:var(--ink-3)}
  .repo-row{display:flex;align-items:center;gap:10px;padding:9px 2px;border-bottom:1px solid var(--border-soft)}
  .repo-row .rn{font-weight:600;font-size:13.5px} .repo-row .rm{margin-left:auto;display:flex;align-items:center;gap:10px}
  .toggle{position:relative;width:38px;height:22px;border-radius:999px;background:var(--surface-2);border:1px solid var(--border);cursor:pointer;transition:background .15s}
  .toggle[aria-checked="true"]{background:var(--accent);border-color:var(--accent)}
  .toggle::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:left .15s} .toggle[aria-checked="true"]::after{left:18px}
  .settings-row{padding:14px 2px;border-bottom:1px solid var(--border-soft)} .settings-row:last-child{border-bottom:0}
  .settings-row .sr-head{display:flex;align-items:center;gap:10px;margin-bottom:10px}
  .settings-row .rn{font-weight:600;font-size:13.5px}
  .settings-row .sr-toggles{display:flex;flex-direction:column;gap:12px;padding-left:2px}
  .sr-toggle{display:flex;align-items:flex-start;gap:12px;cursor:pointer}
  .sr-toggle .toggle{flex:0 0 auto;margin-top:1px}
  .sr-toggle strong{font-size:13px;font-weight:600}
  .view{display:none} .view.active{display:block}
  .banner{background:var(--warn-wash);color:var(--warn);border-radius:10px;padding:10px 14px;font-size:13px;margin-bottom:16px}
  .muted{color:var(--ink-3)} .loading,.empty{color:var(--ink-3);font-size:13px;padding:16px 0}
</style></head>
<body>
<div class="dash">
  <aside class="sidebar">
    <div class="brand"><span class="mark">±</span>Orvex Review</div>
    <div class="ws"><span class="avatar" id="wsAvatar">·</span><span class="meta"><span class="n1" id="wsName">…</span><br><span class="n2" id="wsSlug"></span></span></div>
    <button class="navitem active" data-view="overview"><span class="ico">◧</span>Overview</button>
    <button class="navitem" data-view="pulls"><span class="ico">⇄</span>Pull requests <span class="count" id="cPulls"></span></button>
    <button class="navitem" data-view="findings"><span class="ico">⚑</span>Findings <span class="count" id="cFind"></span></button>
    <button class="navitem" data-view="repos"><span class="ico">▤</span>Repositories <span class="count" id="cRepos"></span></button>
    <button class="navitem" data-view="reviews"><span class="ico">◔</span>Review runs</button>
    <button class="navitem" data-view="installs"><span class="ico">◈</span>Installations</button>
    <button class="navitem" data-view="settings"><span class="ico">⚙</span>Settings</button>
    <div class="spacer"></div>
    <button class="navitem" onclick="location.href='/connect'"><span class="ico">✚</span>Add repositories</button>
    <button class="navitem" onclick="location.href='/auth/logout'"><span class="ico">⇦</span>Sign out</button>
  </aside>

  <main class="main">
    <div class="topbar">
      <div><div class="crumb" id="crumb">—</div><h2 id="viewTitle">Overview</h2></div>
      <div class="right"><button class="btn" id="refresh">Refresh</button></div>
    </div>
    <div class="banner" id="legacyBanner" style="display:none">Viewing without login — set <code>GITHUB_OAUTH_CLIENT_ID</code> to require sign-in.</div>

    <!-- OVERVIEW -->
    <div class="view active" id="v-overview">
      <div class="tiles" id="tiles"><div class="loading">Loading…</div></div>
      <div class="grid2">
        <div class="panel"><h3>Reviews per day</h3><p class="sub">Completed review runs · last 14 days</p>
          <div class="chart" id="chart"><svg viewBox="0 0 640 200" role="img" aria-label="Reviews per day"><g id="gGrid"></g><g id="gBars"></g><g id="gX"></g><g id="gY"></g></svg><div class="tip" id="tip"></div></div>
        </div>
        <div class="panel"><h3>Open findings by severity</h3><p class="sub" id="sevSub">—</p><div class="sev-rows" id="sevRows"></div>
          <h3 style="margin-top:18px">Finding sources</h3><div class="sev-rows" id="srcRows" style="margin-top:10px"></div>
        </div>
      </div>
      <div class="panel"><h3>Recent review runs</h3><p class="sub">Latest webhook-triggered runs</p>
        <div class="tbl-wrap"><table class="reviews"><thead><tr><th>Repo</th><th>PR</th><th>Status</th><th class="num">New</th><th class="num">Fixed</th><th>When</th></tr></thead><tbody id="recentBody"></tbody></table></div>
      </div>
    </div>

    <!-- PULLS --><div class="view" id="v-pulls"><div class="panel"><h3>Pull requests</h3><p class="sub" id="pullSub">—</p><div class="tbl-wrap"><table class="reviews"><thead><tr><th>Repo</th><th>PR</th><th>State</th><th>Open bugs</th><th>Reviewed</th></tr></thead><tbody id="pullBody"></tbody></table></div></div></div>
    <!-- FINDINGS --><div class="view" id="v-findings"><div class="panel"><h3>Findings</h3><p class="sub" id="findSub">Bugs Orvex found, most severe first.</p><div class="tbl-wrap"><table class="reviews"><thead><tr><th>Sev</th><th>Repo · PR</th><th>File</th><th>Finding</th><th>Status</th></tr></thead><tbody id="findBody"></tbody></table></div></div></div>
    <!-- REPOS --><div class="view" id="v-repos"><div class="panel"><h3>Repositories</h3><p class="sub">Toggle which repos Orvex reviews.</p><div id="reposList"><div class="loading">Loading…</div></div></div></div>
    <!-- REVIEWS --><div class="view" id="v-reviews"><div class="panel"><h3>Review runs</h3><p class="sub">Every review & fix run, newest first.</p><div class="tbl-wrap"><table class="reviews"><thead><tr><th>Repo</th><th>PR</th><th>Action</th><th>Status</th><th class="num">Dur</th><th>When</th></tr></thead><tbody id="reviewsBody"></tbody></table></div></div></div>
    <!-- INSTALLS --><div class="view" id="v-installs"><div class="panel"><h3>GitHub installations</h3><p class="sub">Orgs where the Orvex App is installed.</p><div class="installs" id="installs"></div></div></div>
    <!-- SETTINGS --><div class="view" id="v-settings"><div class="panel"><h3>Automatic review triggers</h3><p class="sub">Per repo — control when Orvex reviews run on their own. <code>@orvex review</code> always works regardless of these.</p><div id="settingsList"><div class="loading">Loading…</div></div></div></div>
  </main>
</div>
<script>
const SLUG=${s};
const api=(p)=>fetch('/api/workspaces/'+encodeURIComponent(SLUG)+p,{credentials:'same-origin'}).then(r=>r.ok?r.json():r.json().then(e=>Promise.reject(e)));
const esc=(x)=>String(x==null?'':x).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const sev=(s)=>({P1:'p1',P2:'p2',P3:'p3'}[s]||'muted');
const runCls=(s)=>s==='completed'?'ok':s==='failed'?'p1':s==='running'?'info':'muted';
const runChip=(s)=>'<span class="chip '+runCls(s)+'">'+(s==='running'?'<span class="dot"></span>':'')+esc(s)+'</span>';
const rel=(iso)=>{if(!iso)return'—';const d=(Date.now()-new Date(iso).getTime())/1000;if(d<60)return'just now';if(d<3600)return Math.floor(d/60)+'m ago';if(d<86400)return Math.floor(d/3600)+'h ago';return Math.floor(d/86400)+'d ago';};
document.getElementById('wsName').textContent=SLUG; document.getElementById('wsSlug').textContent=SLUG;
document.getElementById('wsAvatar').textContent=SLUG.slice(0,2).toUpperCase();
document.getElementById('crumb').textContent=SLUG+' / overview';
document.getElementById('refresh').onclick=loadAll;

const titles={overview:'Overview',pulls:'Pull requests',findings:'Findings',repos:'Repositories',reviews:'Review runs',installs:'Installations',settings:'Settings'};
document.querySelectorAll('.navitem[data-view]').forEach(b=>b.onclick=()=>{
  const v=b.dataset.view;
  document.querySelectorAll('.navitem[data-view]').forEach(x=>x.classList.toggle('active',x===b));
  document.querySelectorAll('.view').forEach(x=>x.classList.remove('active'));
  document.getElementById('v-'+v).classList.add('active');
  document.getElementById('viewTitle').textContent=titles[v];
  document.getElementById('crumb').textContent=SLUG+' / '+v;
  if(v==='repos')loadRepos(); if(v==='reviews')loadReviews(); if(v==='settings')loadSettings();
});

async function loadAll(){
  try{
    const o=await api('/overview');
    tiles(o); severity(o.findings); sources();
    document.getElementById('cFind').textContent=o.findings.open||'';
    document.getElementById('cRepos').textContent=(o.repos||[]).filter(r=>r.enabled).length||'';
  }catch(e){document.getElementById('tiles').innerHTML='<div class="empty">'+esc(e.error||'Failed to load — try signing in again')+'</div>';return;}
  loadPulls(); loadFindings(); loadRecent();
}
function tiles(o){
  const f=o.findings, pr=o.pullRequests, s=o.stats;
  const total=(f.open||0)+(f.fixed||0), rate=total?Math.round(f.fixed/total*100):0;
  const enabled=(o.repos||[]).filter(r=>r.enabled).length;
  const avg=s.avgDurationMs?Math.round(s.avgDurationMs/1000)+'s':'—';
  document.getElementById('cPulls').textContent=pr.open||'';
  const spend=s.costUsd!=null?'$'+Number(s.costUsd).toFixed(2):'—';
  document.getElementById('tiles').innerHTML=[
    tile('PRs reviewed · 14d',s.runsCompleted??0,(s.findingsNew||0)+' findings surfaced'),
    tile('Fix rate',rate+'%',f.fixed+' of '+total+' fixed',true),
    tile('LLM spend · 14d',spend,(s.runsCompleted??0)+' reviews'),
    tile('Open findings',f.open??0,(f.bySeverity?.P1||0)+' P1 · '+(f.bySeverity?.P2||0)+' P2'),
  ].join('');
}
const tile=(l,v,d,up)=>'<div class="tile"><div class="lbl">'+esc(l)+'</div><div class="val">'+esc(v)+'</div><div class="delta">'+(up?'<span class="up">▲</span> ':'')+esc(d)+'</div></div>';
function severity(f){
  const by=f.bySeverity||{},max=Math.max(1,by.P1||0,by.P2||0,by.P3||0);
  document.getElementById('sevSub').textContent=(f.open||0)+' open · '+(f.fixed||0)+' fixed · '+(f.ignored||0)+' ignored';
  document.getElementById('sevRows').innerHTML=[['P1 · critical','var(--crit)',by.P1||0],['P2 · warning','var(--warn)',by.P2||0],['P3 · info','var(--accent)',by.P3||0]]
    .map(([n,c,v])=>'<div class="sev-row"><span class="name"><span class="sq" style="background:'+c+'"></span>'+n+'</span><div class="track"><div class="fill" style="width:'+Math.round(v/max*100)+'%;background:'+c+'"></div></div><span class="num">'+v+'</span></div>').join('');
}
async function sources(){
  try{const {findings}=await api('/findings?limit=500');
    const by={}; findings.forEach(f=>{const k=(f.ruleId||'llm').split('.')[0]; by[k]=(by[k]||0)+1;});
    const rows=Object.entries(by).sort((a,b)=>b[1]-a[1]).slice(0,4); const max=Math.max(1,...rows.map(r=>r[1]));
    document.getElementById('srcRows').innerHTML=rows.map(([n,v])=>'<div class="sev-row"><span class="name">'+esc(n)+'</span><div class="track"><div class="fill" style="width:'+Math.round(v/max*100)+'%;background:var(--bar)"></div></div><span class="num">'+v+'</span></div>').join('')||'<div class="empty">No findings yet.</div>';
  }catch{}
}
async function loadRecent(skipChart){
  try{const {reviews}=await api('/reviews?limit=8');const b=document.getElementById('recentBody');
    if(!reviews.length){b.innerHTML='<tr><td colspan="6" class="empty">No reviews yet.</td></tr>';if(!skipChart)drawChart([]);return;}
    b.innerHTML=reviews.map(r=>'<tr><td class="repo">'+esc(r.repo)+'</td><td class="mono">#'+r.pr+'</td><td>'+runChip(r.status)+'</td><td class="num">'+(r.findingsNew||0)+'</td><td class="num">'+(r.findingsFixed||0)+'</td><td class="mono">'+rel(r.createdAt)+'</td></tr>').join('');
    if(!skipChart)drawChart(reviews.length?await perDay():[]);
  }catch{if(!skipChart)drawChart([]);}
}
// Live refresh: while a run is in progress its row shows 'running' — poll the
// active table so it flips to completed/failed without a manual reload.
setInterval(()=>{
  if(document.getElementById('v-overview').classList.contains('active'))loadRecent(true);
  else if(document.getElementById('v-reviews').classList.contains('active')){reviewsLoaded=false;loadReviews();}
},5000);
async function perDay(){
  const {reviews}=await api('/reviews?limit=200');
  const days=[]; for(let i=13;i>=0;i--){const d=new Date(Date.now()-i*86400000);days.push({key:d.toISOString().slice(0,10),label:d.toLocaleDateString(undefined,{month:'short',day:'numeric'}),v:0});}
  const idx={}; days.forEach((d,i)=>idx[d.key]=i);
  reviews.forEach(r=>{if(r.status!=='completed')return;const k=(r.createdAt||'').slice(0,10);if(k in idx)days[idx[k]].v++;});
  return days;
}
function drawChart(data){
  const ns='http://www.w3.org/2000/svg',W=640,H=200,pL=28,pR=8,pT=10,pB=24,pw=W-pL-pR,ph=H-pT-pB;
  const el=(t,a)=>{const e=document.createElementNS(ns,t);for(const k in a)e.setAttribute(k,a[k]);return e;};
  ['gGrid','gBars','gX','gY'].forEach(id=>document.getElementById(id).innerHTML='');
  if(!data.length)return;
  const max=Math.max(4,...data.map(d=>d.v)),n=data.length,slot=pw/n,bw=Math.min(24,slot*0.6);
  const y=v=>pT+ph-(v/max)*ph, g=document.getElementById('gGrid'),bars=document.getElementById('gBars'),gx=document.getElementById('gX'),gy=document.getElementById('gY'),tip=document.getElementById('tip'),svg=document.querySelector('#chart svg');
  [0,Math.round(max/2),max].forEach(t=>{g.appendChild(el('line',{x1:pL,x2:W-pR,y1:y(t),y2:y(t),stroke:t===0?'var(--ink-3)':'var(--grid)','stroke-width':1}));const lb=el('text',{x:pL-6,y:y(t)+3,'text-anchor':'end','font-size':10,fill:'var(--ink-3)','font-family':'var(--mono)'});lb.textContent=t;gy.appendChild(lb);});
  data.forEach((pt,i)=>{const cx=pL+slot*i+slot/2,bh=(pt.v/max)*ph,grp=el('g',{class:'bar-group'});
    const rect=el('rect',{class:'bar-rect',x:cx-bw/2,y:y(pt.v),width:bw,height:Math.max(bh,1),fill:'var(--bar)',rx:3});
    const hit=el('rect',{class:'bar-hit',x:pL+slot*i,y:pT,width:slot,height:ph});
    grp.appendChild(rect);grp.appendChild(hit);
    grp.addEventListener('mousemove',()=>{const box=svg.getBoundingClientRect();tip.innerHTML=pt.label+' · <strong>'+pt.v+'</strong>';tip.style.left=(cx*box.width/W)+'px';tip.style.top=(y(pt.v)*box.height/H)+'px';tip.style.opacity='1';});
    grp.addEventListener('mouseleave',()=>tip.style.opacity='0');
    bars.appendChild(grp);
    if(i%2===0){const xl=el('text',{x:cx,y:H-6,'text-anchor':'middle','font-size':10,fill:'var(--ink-3)'});xl.textContent=pt.label;gx.appendChild(xl);}
  });
}
async function loadPulls(){
  try{const {pulls,counts}=await api('/pulls?limit=100');
    document.getElementById('pullSub').textContent=counts.open+' open · '+counts.merged+' merged · '+counts.closed+' closed';
    const b=document.getElementById('pullBody');
    b.innerHTML=pulls.length?pulls.map(p=>'<tr><td class="mono">'+esc(p.repoFullName.split('/').pop())+'</td><td class="pr-t">#'+p.number+' '+esc(p.title||'')+'</td><td><span class="chip '+(p.state==='merged'?'p3':p.state==='closed'?'muted':'ok')+'">'+p.state+'</span></td><td>'+(p.openFindings>0?'<span class="chip p2">'+p.openFindings+'</span>':'<span class="chip ok">0</span>')+'</td><td class="mono">'+rel(p.lastReviewedAt)+'</td></tr>').join(''):'<tr><td colspan="5" class="empty">No pull requests recorded yet.</td></tr>';
  }catch(e){document.getElementById('pullBody').innerHTML='<tr><td colspan="5" class="empty">'+esc(e.error||'error')+'</td></tr>';}
}
async function loadFindings(){
  try{const {findings}=await api('/findings?limit=100');const b=document.getElementById('findBody');
    b.innerHTML=findings.length?findings.map(f=>'<tr><td><span class="chip '+sev(f.severity)+'">'+esc(f.severity)+'</span></td><td class="mono">'+esc(f.repoFullName.split('/').pop())+' #'+f.prNumber+'</td><td class="mono">'+esc((f.file||'').split('/').pop())+(f.line?':'+f.line:'')+'</td><td class="pr-t">'+esc((f.message||'').slice(0,90))+'</td><td><span class="chip '+(f.status==='fixed'?'ok':f.status==='ignored'?'muted':'p2')+'">'+f.status+(f.status==='fixed'&&f.fixedAtSha?' '+f.fixedAtSha.slice(0,7):'')+'</span></td></tr>').join(''):'<tr><td colspan="5" class="empty">No findings yet.</td></tr>';
  }catch(e){document.getElementById('findBody').innerHTML='<tr><td colspan="5" class="empty">'+esc(e.error||'error')+'</td></tr>';}
}
let reviewsLoaded=false;
async function loadReviews(){if(reviewsLoaded)return;reviewsLoaded=true;
  try{const {reviews}=await api('/reviews?limit=100');const b=document.getElementById('reviewsBody');
    b.innerHTML=reviews.length?reviews.map(r=>'<tr><td class="repo">'+esc(r.repo)+'</td><td class="mono">#'+r.pr+'</td><td class="mono">'+esc(r.action)+'</td><td>'+runChip(r.status)+'</td><td class="num mono">'+(r.status==='running'?'…':r.durationMs?Math.round(r.durationMs/1000)+'s':'—')+'</td><td class="mono">'+rel(r.createdAt)+'</td></tr>').join(''):'<tr><td colspan="6" class="empty">No review runs yet.</td></tr>';
  }catch(e){document.getElementById('reviewsBody').innerHTML='<tr><td colspan="6" class="empty">'+esc(e.error||'error')+'</td></tr>';}
}
let reposLoaded=false;
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
    list.innerHTML=repos.length?repos.map(r=>'<div class="settings-row">'+
      '<div class="sr-head"><span class="rn">'+esc(r.fullName)+'</span>'+(r.enabled?'':'<span class="chip muted">repo disabled</span>')+'</div>'+
      '<div class="sr-toggles">'+
        '<label class="sr-toggle"><button class="toggle" role="switch" aria-checked="'+r.reviewOnOpen+'" data-id="'+r.id+'" data-field="reviewOnOpen"></button><span><strong>Run on each PR</strong><br><span class="muted" style="font-size:12px">Auto-review when a pull request is opened (or reopened)</span></span></label>'+
        '<label class="sr-toggle"><button class="toggle" role="switch" aria-checked="'+r.reviewOnPush+'" data-id="'+r.id+'" data-field="reviewOnPush"></button><span><strong>Run on each commit</strong><br><span class="muted" style="font-size:12px">Auto-review again on every new push to an open PR</span></span></label>'+
      '</div></div>'
    ).join(''):'<div class="empty">No repositories. Click “Add repositories”.</div>';
    list.querySelectorAll('.toggle').forEach(t=>t.onclick=()=>toggleSetting(t));
  }catch(e){list.innerHTML='<div class="empty">'+esc(e.error||'error')+'</div>';}
}
async function toggleSetting(t){const next=t.getAttribute('aria-checked')!=='true';t.setAttribute('aria-checked',next);
  try{await fetch('/api/workspaces/'+encodeURIComponent(SLUG)+'/repos/'+t.dataset.id,{method:'PATCH',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({[t.dataset.field]:next})}).then(r=>{if(!r.ok)throw 0;});}catch{t.setAttribute('aria-checked',!next);}
}
async function loadInstalls(){
  try{const {installations}=await api('/installations');const el=document.getElementById('installs');
    el.innerHTML=installations.length?installations.map(i=>'<div class="install-row"><span class="avatar">'+esc((i.account||'?').slice(0,2).toUpperCase())+'</span><div><div class="org">'+esc(i.account)+' <span class="chip '+(i.suspended?'p2':'ok')+'" style="margin-left:6px"><span class="dot"></span>'+(i.suspended?'Suspended':'Active')+'</span></div><div class="meta">'+esc(i.accountType)+' · '+esc(i.repositorySelection)+' · #'+i.installationId+'</div></div><div class="right"><button class="ghost" onclick="location.href=\\'/connect\\'">Configure</button></div></div>').join(''):'<div class="empty">No installations.</div>';
  }catch(e){document.getElementById('installs').innerHTML='<div class="empty">'+esc(e.error||'error')+'</div>';}
}
loadAll(); loadInstalls();
</script>
</body></html>`;
}
