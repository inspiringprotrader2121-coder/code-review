import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { Hono } from 'hono';
import { createAppDatabase } from '@orvex-review/store';
import { createInstallationOctokit, loadGitHubConfigFromEnv } from '@orvex-review/github';
import { buildScoreboard, type Scoreboard } from '../scoreboard.js';
import { buildDeepScorecard } from '../deep-scorecard.js';
import { authorizedAdmin } from './admin-auth.js';
import { pageShell } from './pages.js';
import { sessionUser } from './session.js';

/**
 * SUPER-ADMIN area — operator-only tooling, completely separate from tenant
 * dashboards. Browser access requires a signed-in user with the database-backed
 * super-admin role. Bearer-secret access remains available for automation.
 *
 * Contents: the competitive scoreboard (ROADMAP Phase 1) — Orvex vs the other
 * review bots on this repo's PRs: catch counts, unique catches, and the
 * miss list (defects others flagged that Orvex didn't → each one is a
 * candidate rule/lens improvement).
 */

function scoreboardPath(): string {
  const dir = process.env.STORE_PATH ? path.dirname(process.env.STORE_PATH) : path.resolve('./data');
  return path.join(dir, 'scoreboard.json');
}

export function superadminRoutes() {
  const app = new Hono();
  const db = createAppDatabase();

  app.get('/superadmin', (c) => {
    const user = sessionUser(c, db);
    if (!user) return c.redirect('/auth/login?next=/superadmin');
    if (!user.isSuperAdmin) {
      return c.html(pageShell('Access denied', '<h1>Access denied</h1><p>This account is not a super administrator.</p>', user), 403);
    }
    return c.html(PAGE);
  });

  app.get('/superadmin/api/scoreboard', (c) => {
    if (!authorizedAdmin(c, db)) return c.json({ error: 'unauthorized' }, 401);
    try {
      return c.json(JSON.parse(readFileSync(scoreboardPath(), 'utf8')) as Scoreboard);
    } catch {
      return c.json({ error: 'no scoreboard yet — run a rebuild' }, 404);
    }
  });

  app.post('/superadmin/api/scoreboard/rebuild', async (c) => {
    if (!authorizedAdmin(c, db)) return c.json({ error: 'unauthorized' }, 401);
    const maxPrs = Math.min(Number(c.req.query('prs') ?? 60), 200);
    const github = loadGitHubConfigFromEnv();
    // ALL connected repos across ALL tenants (operator-only view, so
    // cross-tenant aggregation is appropriate here and nowhere else).
    const targets = db.listScanTargets();
    if (targets.length === 0) return c.json({ error: 'no repos connected' }, 400);

    // Stamp the snapshot with the ruleset hash so results are attributable to a
    // CONFIG ERA — "were the old settings outperforming?" becomes answerable by
    // comparing snapshots with different hashes (see /scoreboard/history).
    let rulesHash = 'unknown';
    for (const cand of [path.resolve('rules/orvex-rules.md'), path.resolve('../../rules/orvex-rules.md')]) {
      try {
        rulesHash = createHash('sha256').update(readFileSync(cand)).digest('hex').slice(0, 12);
        break;
      } catch {
        /* try next candidate (cwd differs under pm2: repo root vs apps/server) */
      }
    }

    const boards = [];
    for (const t of targets) {
      const octokit = createInstallationOctokit(github, t.installationId);
      try {
        const b = await buildScoreboard(octokit, t.owner, t.name, maxPrs);
        b.rulesHash = rulesHash;
        boards.push(b);
      } catch (err) {
        console.warn(`[superadmin] scoreboard failed for ${t.fullName}:`, (err as Error).message);
      }
    }
    if (boards.length === 0) return c.json({ error: 'all repos failed to score' }, 502);
    // Single-repo shape stays backward-compatible; multi-repo adds `repos`.
    const primary = boards[0];
    const combined = boards.length === 1 ? primary : { ...primary, repos: boards.map((b) => ({ repo: b.repo, prsAnalyzed: b.prsAnalyzed, bots: b.bots, clustersTotal: b.clusters.total })) };

    mkdirSync(path.dirname(scoreboardPath()), { recursive: true });
    writeFileSync(scoreboardPath(), JSON.stringify(combined, null, 2));
    // History snapshot: every rebuild is preserved so config eras stay comparable.
    const histDir = path.join(path.dirname(scoreboardPath()), 'scoreboard-history');
    mkdirSync(histDir, { recursive: true });
    writeFileSync(
      path.join(histDir, `${new Date().toISOString().replace(/[:.]/g, '-')}_${rulesHash}.json`),
      JSON.stringify(combined, null, 2),
    );
    return c.json(combined);
  });

  // List preserved snapshots: filename encodes timestamp + rules hash, so a
  // performance comparison across config eras is a two-file diff.
  app.get('/superadmin/api/scoreboard/history', (c) => {
    if (!authorizedAdmin(c, db)) return c.json({ error: 'unauthorized' }, 401);
    const histDir = path.join(path.dirname(scoreboardPath()), 'scoreboard-history');
    if (!existsSync(histDir)) return c.json({ snapshots: [] });
    return c.json({ snapshots: readdirSync(histDir).sort().reverse() });
  });

  // Deep-vs-normal scorecard: reads review_runs (deep flag + per-run new
  // findings) and pairs normal-then-deep runs on the same commit — deep's
  // marginal severe-finding rate is the evidence for its 2× price.
  app.get('/superadmin/api/deep-scorecard', (c) => {
    if (!authorizedAdmin(c, db)) return c.json({ error: 'unauthorized' }, 401);
    return c.json(buildDeepScorecard(db.listScorecardRuns(1000)));
  });

  return app;
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Orvex · Super Admin</title>
<style>
:root{--bg:#0e1015;--panel:#161a22;--ink:#e8eaf0;--ink2:#a2a8b8;--line:#262a34;--accent:#4f5df0;--bad:#e5534b;--good:#3fb950}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
main{max-width:1100px;margin:0 auto;padding:28px 20px 80px}
h1{font-size:20px}h2{font-size:15px;margin:28px 0 10px;color:var(--ink2);text-transform:uppercase;letter-spacing:.06em}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:10px 0}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
th,td{padding:6px 10px;text-align:left;border-bottom:1px solid var(--line);font-size:13px}
th{color:var(--ink2);font-weight:600}
input,button{font:inherit;border-radius:8px;border:1px solid var(--line);background:#0b0d12;color:var(--ink);padding:8px 12px}
button{background:var(--accent);border:0;cursor:pointer;font-weight:600}
button:disabled{opacity:.5;cursor:default}
.badge{display:inline-block;padding:1px 8px;border-radius:99px;font-size:12px;border:1px solid var(--line)}
.miss{color:var(--bad)}.unique{color:var(--good)}
.mono{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:var(--ink2)}
#status{color:var(--ink2);font-size:13px;margin-left:10px}
</style></head><body><main>
<h1>Super Admin · Scoreboard</h1>
<div class="panel">
  <button id="rebuild">Rebuild (reads GitHub, ~$0)</button>
  <button id="security">Account security</button>
  <span id="status"></span>
</div>
<div id="deep"></div>
<div id="content"></div>
<script>
const $=(s)=>document.querySelector(s);
async function api(p,opts){const r=await fetch(p,{...opts,credentials:'same-origin'});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||r.status);return j}
function esc(s){return String(s??'').replace(/[&<>"]/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
function render(b){
  const bots=Object.entries(b.bots).sort((x,y)=>y[1].clustersHit-x[1].clustersHit);
  let h='<h2>Catch rate · '+esc(b.repo)+' · '+b.prsAnalyzed+' PRs · '+b.clusters.total+' defect clusters · rules '+esc(b.rulesHash||'?')+' · '+esc(b.generatedAt)+'</h2>';
  if(b.trend){const t=b.trend;const d=t.recent.orvexCatchPct-t.older.orvexCatchPct;
    h+='<div class="panel">Trend — Orvex catch rate: recent half ('+t.recent.prs+' PRs) <strong>'+t.recent.orvexCatchPct+'%</strong> vs older half ('+t.older.prs+' PRs) <strong>'+t.older.orvexCatchPct+'%</strong> → <span class="'+(d>=0?'unique':'miss')+'">'+(d>=0?'+':'')+d+' pts</span>. Snapshots per config era: <span class="mono">GET /superadmin/api/scoreboard/history</span></div>';}
  h+='<div class="panel"><table><tr><th>Bot</th><th>Findings</th><th>Clusters hit</th><th>Catch %</th><th>Unique catches</th><th>PRs w/ findings</th></tr>';
  for(const [name,s] of bots){h+='<tr><td><strong>'+esc(name)+'</strong></td><td>'+s.findings+'</td><td>'+s.clustersHit+'</td><td>'+(b.clusters.total?Math.round(100*s.clustersHit/b.clusters.total):0)+'%</td><td class="unique">'+s.uniqueClusters+'</td><td>'+s.prsWithFindings+'</td></tr>'}
  h+='</table></div>';
  h+='<h2 class="miss">Orvex missed ('+b.clusters.orvexMissed.length+') — each is a candidate rule/lens</h2><div class="panel"><table><tr><th>PR</th><th>Location</th><th>Sev</th><th>Bots</th><th>Excerpt</th></tr>';
  for(const m of b.clusters.orvexMissed){h+='<tr><td>#'+m.pr+'</td><td class="mono">'+esc(m.path||'?')+':'+(m.line??'?')+'</td><td>'+esc(m.severity||'—')+'</td><td>'+m.bots.map(esc).join(', ')+'</td><td class="mono">'+esc(m.excerpt)+'</td></tr>'}
  h+='</table></div>';
  h+='<h2 class="unique">Only Orvex caught ('+b.clusters.orvexUnique.length+') — marketing ammo</h2><div class="panel"><table><tr><th>PR</th><th>Location</th><th>Sev</th><th>Excerpt</th></tr>';
  for(const m of b.clusters.orvexUnique){h+='<tr><td>#'+m.pr+'</td><td class="mono">'+esc(m.path||'?')+':'+(m.line??'?')+'</td><td>'+esc(m.severity||'—')+'</td><td class="mono">'+esc(m.excerpt)+'</td></tr>'}
  h+='</table></div>';
  h+='<h2>Per-PR finding counts</h2><div class="panel"><table><tr><th>PR</th><th>Title</th><th>State</th><th>Counts</th></tr>';
  for(const p of b.perPr){const c=Object.entries(p.counts).map(([k,v])=>k+':'+v).join('  ')||'—';h+='<tr><td>#'+p.pr+'</td><td>'+esc(p.title.slice(0,70))+'</td><td>'+esc(p.state)+'</td><td class="mono">'+esc(c)+'</td></tr>'}
  h+='</table></div>';
  $('#content').innerHTML=h;
}
function renderDeep(d){
  let h='<h2>Deep vs Normal · '+d.totals.normalRuns+' normal / '+d.totals.deepRuns+' deep runs · '+esc(d.generatedAt)+'</h2>';
  h+='<div class="panel"><table><tr><th></th><th>Avg cost</th><th>Avg duration</th><th>Avg new findings/run</th></tr>';
  h+='<tr><td><strong>Normal</strong></td><td>$'+d.totals.avgCostNormal.toFixed(3)+'</td><td>'+Math.round(d.totals.avgDurationSNormal)+'s</td><td>'+d.totals.avgNewFindingsNormal.toFixed(1)+'</td></tr>';
  h+='<tr><td><strong>Deep</strong></td><td>$'+d.totals.avgCostDeep.toFixed(3)+'</td><td>'+Math.round(d.totals.avgDurationSDeep)+'s</td><td>'+d.totals.avgNewFindingsDeep.toFixed(1)+'</td></tr></table></div>';
  h+='<div class="panel">A/B pairs (normal first, then deep, same commit): <strong>'+d.pairs.length+'</strong> · deep added a P1/P2 beyond normal on <strong class="'+(d.pairs.length&&d.pairsWhereDeepAddedSevere/d.pairs.length>=0.5?'unique':'miss')+'">'+d.pairsWhereDeepAddedSevere+' / '+d.pairs.length+'</strong> pairs · unpaired deep runs (no prior normal, not marginal): '+d.unpairedDeepRuns+'</div>';
  if(d.pairs.length){h+='<div class="panel"><table><tr><th>PR@commit</th><th>Normal found (P1/P2/P3/info)</th><th>Deep ADDED (P1/P2/P3/info)</th><th>Normal $</th><th>Deep $</th></tr>';
    const f=(x)=>x.P1+'/'+x.P2+'/'+x.P3+'/'+x.info;
    for(const p of d.pairs){h+='<tr><td class="mono">#'+p.pr+'@'+esc(p.headSha.slice(0,7))+'</td><td>'+f(p.normal.found)+'</td><td class="'+((p.deepMarginal.found.P1+p.deepMarginal.found.P2)>0?'unique':'')+'">'+f(p.deepMarginal.found)+'</td><td>$'+p.normal.costUsd.toFixed(3)+'</td><td>$'+p.deepMarginal.costUsd.toFixed(3)+'</td></tr>'}
    h+='</table></div>';}
  $('#deep').innerHTML=h;
}
async function load(){ $('#status').textContent='loading…';try{render(await api('/superadmin/api/scoreboard'));renderDeep(await api('/superadmin/api/deep-scorecard'));$('#status').textContent=''}catch(e){$('#status').textContent=e.message} }
$('#rebuild').onclick=async()=>{$('#rebuild').disabled=true;$('#status').textContent='rebuilding — reading PR comments from GitHub…';try{render(await api('/superadmin/api/scoreboard/rebuild?prs=80',{method:'POST'}));$('#status').textContent='rebuilt ✓'}catch(e){$('#status').textContent=e.message}finally{$('#rebuild').disabled=false}};
$('#security').onclick=()=>{location.href='/settings/security'};
load();
</script>
</main></body></html>`;
