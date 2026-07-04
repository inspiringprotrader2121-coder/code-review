import { Hono } from 'hono';
import { createAppDatabase } from '@orvex-review/store';
import { legacyAuthMode } from '@orvex-review/tenants';
import { sessionUser } from './session.js';


export function dashboardRoutes() {
  const app = new Hono();
  const db = createAppDatabase();

  // /dashboard → pick the caller's workspace (or, in legacy mode, the first one)
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
    // require login (unless in legacy no-auth mode); members only
    if (!legacyAuthMode()) {
      const user = sessionUser(c, db);
      if (!user) return c.redirect(`/auth/login?next=/dashboard/${encodeURIComponent(slug)}`);
      const tenant = db.getTenantBySlug(slug);
      if (!tenant || !db.getMembership(tenant.id, user.id)) {
        return c.redirect('/dashboard');
      }
    }
    return c.html(dashboardHtml(slug));
  });

  return app;
}

function dashboardHtml(slug: string): string {
  const s = JSON.stringify(slug);
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
    --crit:#b32f2f; --crit-wash:rgba(208,59,59,.10); --grid:#e3e3e9; --btn-ink:#fff;
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
    --crit:#e66767; --crit-wash:rgba(230,103,103,.13); --grid:#262732; --btn-ink:#14151c;
    --shadow:0 1px 2px rgba(0,0,0,.35),0 10px 32px rgba(0,0,0,.35);
  }}
  *{box-sizing:border-box}
  body{margin:0;background:var(--page);color:var(--ink);font-family:var(--body);font-size:15px;line-height:1.55;-webkit-font-smoothing:antialiased}
  h1,h2,h3{font-family:var(--display);margin:0}
  a{color:var(--accent-ink);text-decoration:none}
  code{font-family:var(--mono);font-size:.9em}
  .top{display:flex;align-items:center;gap:12px;max-width:1160px;margin:0 auto;padding:18px 24px}
  .mark{width:28px;height:28px;border-radius:8px;background:var(--accent);color:var(--btn-ink);font-weight:700;font-family:var(--mono);display:inline-flex;align-items:center;justify-content:center}
  .brand{font-weight:700;font-size:16px}
  .top .ws{margin-left:6px;color:var(--ink-3);font-size:13px;font-family:var(--mono)}
  .top .right{margin-left:auto;display:flex;gap:8px;align-items:center}
  .btn{border:1px solid var(--border);background:var(--surface);color:var(--ink);border-radius:8px;padding:7px 13px;font-size:13px;font-weight:600;cursor:pointer}
  .btn.primary{background:var(--accent);border-color:var(--accent);color:var(--btn-ink)}
  .wrap{max-width:1160px;margin:0 auto;padding:6px 24px 60px}
  .banner{background:var(--warn-wash);color:var(--warn);border-radius:10px;padding:10px 14px;font-size:13px;margin-bottom:16px}
  .tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:16px}
  @media(max-width:900px){.tiles{grid-template-columns:repeat(2,1fr)}}
  .tile{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:15px 17px}
  .tile .lbl{font-size:12px;color:var(--ink-2);font-weight:550}
  .tile .val{font-size:27px;font-weight:700;font-family:var(--display);letter-spacing:-.01em;margin:3px 0 2px}
  .tile .delta{font-size:12px;color:var(--ink-3)}
  .tile .delta .up{color:var(--good);font-weight:650}
  .grid2{display:grid;grid-template-columns:1.3fr 1fr;gap:14px;margin-bottom:16px}
  @media(max-width:900px){.grid2{grid-template-columns:1fr}}
  .panel{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:17px 18px;min-width:0}
  .panel h3{font-size:14px;font-weight:650;margin-bottom:3px}
  .panel .sub{font-size:12px;color:var(--ink-3);margin:0 0 14px}
  .sev-row{display:grid;grid-template-columns:96px 1fr 34px;gap:10px;align-items:center;margin-bottom:11px}
  .sev-row .name{display:flex;align-items:center;gap:7px;font-size:12.5px;font-weight:600}
  .sev-row .sq{width:9px;height:9px;border-radius:3px;flex:0 0 auto}
  .sev-row .track{height:9px;background:var(--surface-2);border-radius:5px;overflow:hidden}
  .sev-row .fill{height:100%;border-radius:5px;transition:width .6s cubic-bezier(.22,1,.36,1)}
  .sev-row .num{font-family:var(--mono);font-size:12px;text-align:right;color:var(--ink-2)}
  table{border-collapse:collapse;width:100%;font-size:13px}
  th{text-align:left;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-3);padding:8px 10px;border-bottom:1px solid var(--border)}
  td{padding:9px 10px;border-bottom:1px solid var(--border-soft);vertical-align:middle}
  tr:last-child td{border-bottom:0}
  tbody tr:hover{background:var(--surface-2)}
  .mono{font-family:var(--mono);font-size:12px;color:var(--ink-2)}
  .chip{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px;white-space:nowrap}
  .chip.p1{color:var(--crit);background:var(--crit-wash)} .chip.p2{color:var(--warn);background:var(--warn-wash)}
  .chip.p3{color:var(--accent-ink);background:var(--accent-wash)} .chip.ok{color:var(--good);background:var(--good-wash)}
  .chip.muted{color:var(--ink-3);background:var(--surface-2)}
  .tbl-wrap{overflow-x:auto}
  .tabs{display:flex;gap:4px;margin-bottom:14px}
  .tabs button{border:1px solid var(--border);background:var(--surface);color:var(--ink-2);border-radius:8px;padding:6px 13px;font-size:13px;font-weight:600;cursor:pointer}
  .tabs button[aria-selected="true"]{background:var(--accent-wash);color:var(--accent-ink);border-color:transparent}
  .repo-row{display:flex;align-items:center;gap:10px;padding:9px 2px;border-bottom:1px solid var(--border-soft)}
  .repo-row .rn{font-weight:600;font-size:13.5px}
  .repo-row .rm{margin-left:auto;display:flex;align-items:center;gap:10px}
  .toggle{position:relative;width:38px;height:22px;border-radius:999px;background:var(--surface-2);border:1px solid var(--border);cursor:pointer;transition:background .15s}
  .toggle[aria-checked="true"]{background:var(--accent);border-color:var(--accent)}
  .toggle::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:left .15s}
  .toggle[aria-checked="true"]::after{left:18px}
  .muted{color:var(--ink-3)}
  .loading{color:var(--ink-3);font-size:13px;padding:20px 0}
  .empty{color:var(--ink-3);font-size:13px;padding:14px 0}
  :focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px}
</style></head>
<body>
  <div class="top">
    <span class="mark">±</span><span class="brand">Orvex Review</span>
    <span class="ws" id="wsName"></span>
    <div class="right">
      <button class="btn" onclick="location.href='/connect'">Add repos</button>
      <button class="btn primary" id="refresh">Refresh</button>
    </div>
  </div>
  <div class="wrap">
    <div class="banner" id="legacyBanner" style="display:none">
      Viewing without login — enable <code>GITHUB_OAUTH_CLIENT_ID</code> to secure this dashboard per user.
    </div>

    <div class="tiles" id="tiles"><div class="loading">Loading…</div></div>

    <div class="grid2">
      <div class="panel">
        <h3>Pull requests</h3>
        <p class="sub" id="prSub">—</p>
        <div class="tbl-wrap"><table><thead><tr><th>Repo</th><th>PR</th><th>State</th><th>Open bugs</th><th>Reviewed</th></tr></thead><tbody id="prBody"></tbody></table></div>
      </div>
      <div class="panel">
        <h3>Open findings by severity</h3>
        <p class="sub" id="findSub">—</p>
        <div id="sevBars"></div>
      </div>
    </div>

    <div class="panel" style="margin-bottom:16px">
      <div class="tabs">
        <button id="tab-findings" aria-selected="true" onclick="showTab('findings')">Findings</button>
        <button id="tab-repos" aria-selected="false" onclick="showTab('repos')">Repositories</button>
      </div>
      <div id="view-findings">
        <p class="sub" id="findingsHint">Bugs Orvex found, newest first. Fixed ones show their commit.</p>
        <div class="tbl-wrap"><table><thead><tr><th>Sev</th><th>Repo · PR</th><th>File</th><th>Finding</th><th>Status</th></tr></thead><tbody id="findingsBody"></tbody></table></div>
      </div>
      <div id="view-repos" style="display:none">
        <p class="sub">Toggle which repositories Orvex reviews. All accessible repos are listed.</p>
        <div id="reposList"></div>
      </div>
    </div>
  </div>

<script>
const SLUG = ${s};
const api = (p) => fetch('/api/workspaces/' + encodeURIComponent(SLUG) + p, { credentials:'same-origin' }).then(r => r.ok ? r.json() : r.json().then(e => Promise.reject(e)));
const esc = (x) => String(x==null?'':x).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const sevClass = (s) => ({P1:'p1',P2:'p2',P3:'p3'}[s] || 'muted');

document.getElementById('wsName').textContent = SLUG;
document.getElementById('refresh').onclick = loadAll;

function showTab(t){
  document.getElementById('tab-findings').setAttribute('aria-selected', t==='findings');
  document.getElementById('tab-repos').setAttribute('aria-selected', t==='repos');
  document.getElementById('view-findings').style.display = t==='findings'?'':'none';
  document.getElementById('view-repos').style.display = t==='repos'?'':'none';
  if (t==='repos') loadRepos();
}

async function loadAll(){
  try {
    const o = await api('/overview');
    renderTiles(o);
    renderSeverity(o.findings);
    document.getElementById('findSub').textContent = (o.findings.open||0) + ' open · ' + (o.findings.fixed||0) + ' fixed · ' + (o.findings.ignored||0) + ' ignored';
    document.getElementById('prSub').textContent = o.pullRequests.open + ' open · ' + o.pullRequests.merged + ' merged · ' + o.pullRequests.closed + ' closed';
  } catch(e){ document.getElementById('tiles').innerHTML = '<div class="empty">'+esc(e.error||'Failed to load')+'</div>'; return; }
  loadPulls(); loadFindings();
}

function renderTiles(o){
  const s = o.stats, f = o.findings, pr = o.pullRequests;
  const total = (f.open||0)+(f.fixed||0);
  const rate = total ? Math.round((f.fixed/total)*100) : 0;
  const enabled = (o.repos||[]).filter(r=>r.enabled).length;
  document.getElementById('tiles').innerHTML = [
    tile('PRs reviewed · 14d', s.runsCompleted ?? 0, (s.findingsNew||0)+' findings surfaced'),
    tile('Fix rate', rate+'%', f.fixed+' of '+total+' findings fixed', true),
    tile('Open findings', f.open ?? 0, (f.bySeverity?.P1||0)+' P1 · '+(f.bySeverity?.P2||0)+' P2'),
    tile('Repositories', enabled+' / '+(o.repos||[]).length, 'enabled for review'),
  ].join('');
}
const tile = (lbl,val,delta,up) => '<div class="tile"><div class="lbl">'+esc(lbl)+'</div><div class="val">'+esc(val)+'</div><div class="delta">'+(up?'<span class="up">▲</span> ':'')+esc(delta)+'</div></div>';

function renderSeverity(f){
  const by = f.bySeverity||{}; const max = Math.max(1, by.P1||0, by.P2||0, by.P3||0);
  const rows = [['P1 · critical','var(--crit)',by.P1||0],['P2 · warning','var(--warn)',by.P2||0],['P3 · info','var(--accent)',by.P3||0]];
  document.getElementById('sevBars').innerHTML = rows.map(([n,c,v]) =>
    '<div class="sev-row"><span class="name"><span class="sq" style="background:'+c+'"></span>'+n+'</span><div class="track"><div class="fill" style="width:'+Math.round(v/max*100)+'%;background:'+c+'"></div></div><span class="num">'+v+'</span></div>'
  ).join('');
}

async function loadPulls(){
  try {
    const { pulls } = await api('/pulls?limit=12');
    const body = document.getElementById('prBody');
    if (!pulls.length){ body.innerHTML='<tr><td colspan="5" class="empty">No pull requests recorded yet.</td></tr>'; return; }
    body.innerHTML = pulls.map(p => '<tr><td class="mono">'+esc(p.repoFullName.split('/').pop())+'</td>'+
      '<td>#'+p.number+' '+esc((p.title||'').slice(0,42))+'</td>'+
      '<td><span class="chip '+(p.state==='merged'?'p3':p.state==='closed'?'muted':'ok')+'">'+p.state+'</span></td>'+
      '<td>'+(p.openFindings>0?'<span class="chip p2">'+p.openFindings+'</span>':'<span class="chip ok">0</span>')+'</td>'+
      '<td class="mono">'+(p.lastReviewedAt?rel(p.lastReviewedAt):'—')+'</td></tr>').join('');
  } catch(e){ document.getElementById('prBody').innerHTML='<tr><td colspan="5" class="empty">'+esc(e.error||'error')+'</td></tr>'; }
}

async function loadFindings(){
  try {
    const { findings } = await api('/findings?limit=40');
    const body = document.getElementById('findingsBody');
    if (!findings.length){ body.innerHTML='<tr><td colspan="5" class="empty">No findings yet.</td></tr>'; return; }
    body.innerHTML = findings.map(f => '<tr><td><span class="chip '+sevClass(f.severity)+'">'+esc(f.severity)+'</span></td>'+
      '<td class="mono">'+esc(f.repoFullName.split('/').pop())+' #'+f.prNumber+'</td>'+
      '<td class="mono">'+esc((f.file||'').split('/').pop())+(f.line?':'+f.line:'')+'</td>'+
      '<td>'+esc((f.message||'').slice(0,80))+'…</td>'+
      '<td><span class="chip '+(f.status==='fixed'?'ok':f.status==='ignored'?'muted':'p2')+'">'+f.status+(f.status==='fixed'&&f.fixedAtSha?' '+f.fixedAtSha.slice(0,7):'')+'</span></td></tr>').join('');
  } catch(e){ document.getElementById('findingsBody').innerHTML='<tr><td colspan="5" class="empty">'+esc(e.error||'error')+'</td></tr>'; }
}

let reposLoaded = false;
async function loadRepos(){
  if (reposLoaded) return; reposLoaded = true;
  const list = document.getElementById('reposList');
  list.innerHTML = '<div class="loading">Loading repositories…</div>';
  try {
    const { repos } = await api('/repos');
    if (!repos.length){ list.innerHTML='<div class="empty">No repositories synced. Click “Add repos”.</div>'; return; }
    list.innerHTML = repos.map(r => '<div class="repo-row"><span class="rn">'+esc(r.fullName)+'</span>'+
      '<span class="rm"><span class="muted" style="font-size:12px">'+(r.private?'private':'public')+'</span>'+
      '<button class="toggle" role="switch" aria-checked="'+r.enabled+'" data-id="'+r.id+'" title="Toggle review"></button></span></div>').join('');
    list.querySelectorAll('.toggle').forEach(t => t.onclick = () => toggleRepo(t));
  } catch(e){ list.innerHTML='<div class="empty">'+esc(e.error||'error')+'</div>'; }
}
async function toggleRepo(t){
  const next = t.getAttribute('aria-checked') !== 'true';
  t.setAttribute('aria-checked', next);
  try {
    await fetch('/api/workspaces/'+encodeURIComponent(SLUG)+'/repos/'+t.dataset.id, {
      method:'PATCH', credentials:'same-origin', headers:{'content-type':'application/json'}, body:JSON.stringify({enabled:next})
    }).then(r => { if(!r.ok) throw 0; });
  } catch { t.setAttribute('aria-checked', !next); }
}

function rel(iso){ const d=(Date.now()-new Date(iso).getTime())/1000; if(d<60)return'just now'; if(d<3600)return Math.floor(d/60)+'m ago'; if(d<86400)return Math.floor(d/3600)+'h ago'; return Math.floor(d/86400)+'d ago'; }

fetch('/health').then(r=>r.json()).then(()=>{}).catch(()=>{});
if (${legacyAuthMode()}) document.getElementById('legacyBanner').style.display='';
loadAll();
</script>
</body></html>`;
}
