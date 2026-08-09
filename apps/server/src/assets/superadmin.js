const $ = (s) => document.querySelector(s);
let liveRequest;
async function api(p, opts) {
  const r = await fetch(p, { ...opts, credentials: 'same-origin' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.status);
  return j;
}
function esc(s) {
  return String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}
function number(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function whole(v, fallback = 0) {
  return Math.max(0, Math.trunc(number(v, fallback)));
}
function money(v) {
  return '$' + number(v).toFixed(2);
}
function currencyMoney(currency, v) {
  return String(currency || '').toUpperCase() + ' ' + number(v).toFixed(2);
}
function pct(v) {
  return v === null || v === undefined ? '—' : number(v).toFixed(1) + '%';
}
function tokens(v) {
  v = number(v);
  if (v >= 1000000) return (v / 1000000).toFixed(2) + 'M';
  if (v >= 1000) return (v / 1000).toFixed(1) + 'k';
  return String(v);
}
function marginClass(v) {
  return v === null || v === undefined ? '' : v < 0 ? 'negative' : 'positive';
}
function bytes(v) {
  v = number(v);
  if (v >= 1073741824) return (v / 1073741824).toFixed(2) + ' GiB';
  if (v >= 1048576) return (v / 1048576).toFixed(1) + ' MiB';
  if (v >= 1024) return (v / 1024).toFixed(0) + ' KiB';
  return v + ' B';
}
function elapsed(ms) {
  ms = number(ms);
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return m + 'm ' + r + 's';
  return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
}
function usageBar(used, total, warnAt, badAt) {
  const safeTotal = number(total);
  const p = safeTotal > 0 ? Math.min(100, (number(used) / safeTotal) * 100) : 0;
  const cls = p >= badAt ? 'bad' : p >= warnAt ? 'warn' : '';
  return (
    '<progress class="meter ' +
    cls +
    '" max="100" value="' +
    p.toFixed(1) +
    '"></progress><div class="mini">' +
    bytes(used) +
    ' / ' +
    bytes(total) +
    ' (' +
    p.toFixed(0) +
    '%)</div>'
  );
}
function renderLive(d) {
  const hst = d.host || {};
  const mem = hst.memory || {};
  const disk = hst.disk || {};
  const w = hst.worker || {};
  const q = d.queue || {};
  const load = (hst.loadAverage || [0, 0, 0]).map((x) => Number(x).toFixed(2)).join(' / ');
  let html = '<h2>Live server · active client reviews</h2>';
  html += '<div class="kpis">';
  html +=
    '<div class="kpi info"><div class="value">' +
    (w.activeReviews || 0) +
    ' / ' +
    (w.maxConcurrentReviews || 0) +
    '</div><div class="label">Active reviews / capacity</div></div>';
  html +=
    '<div class="kpi ' +
    (Number(q.queued || 0) + Number(q.waitingOnPr || 0) > 0 ? 'warn' : '') +
    '"><div class="value">' +
    (Number(q.queued || 0) + Number(q.waitingOnPr || 0)) +
    '</div><div class="label">Queue depth (ready + waiting)</div></div>';
  html +=
    '<div class="kpi"><div class="value">' +
    (q.oldestWaitMs == null ? '—' : elapsed(q.oldestWaitMs)) +
    '</div><div class="label">Oldest queued wait</div></div>';
  html +=
    '<div class="kpi"><div class="value">' +
    bytes(mem.availableBytes) +
    '</div><div class="label">RAM available</div></div>';
  html +=
    '<div class="kpi ' +
    (Number(mem.usedBytes) / Math.max(1, Number(mem.totalBytes)) > 0.85 ? 'warn' : '') +
    '"><div class="value">' +
    bytes(mem.usedBytes) +
    '</div><div class="label">RAM used (of ' +
    bytes(mem.totalBytes) +
    ')</div></div>';
  html +=
    '<div class="kpi"><div class="value">' +
    load +
    '</div><div class="label">Load 1 / 5 / 15 · ' +
    esc(hst.cpuCount) +
    ' CPUs</div></div>';
  html += '</div>';
  html +=
    '<div class="split"><div class="panel"><div class="section-head"><strong>Host memory</strong><span class="note">available = what Linux can give apps</span></div>' +
    usageBar(mem.usedBytes, mem.totalBytes, 75, 90);
  if (mem.swapTotalBytes > 0)
    html +=
      '<div class="mini top-gap">Swap used ' +
      bytes(mem.swapUsedBytes) +
      ' / ' +
      bytes(mem.swapTotalBytes) +
      '</div>';
  html +=
    '</div><div class="panel"><div class="section-head"><strong>Queue pressure</strong><span class="note">ready ' +
    Number(q.queued || 0) +
    ' · waiting on PR ' +
    Number(q.waitingOnPr || 0) +
    ' · backend in-flight ' +
    Number(q.inFlight || 0) +
    '</span></div>';
  html +=
    '<p class="muted flush">Worker Node RSS <strong>' +
    bytes(w.rssBytes) +
    '</strong> · disk free <strong>' +
    bytes(disk.availableBytes) +
    '</strong> · path <span class="mono">' +
    esc(disk.path || '') +
    '</span></p>';
  if (Number(q.queued || 0) + Number(q.waitingOnPr || 0) === 0)
    html +=
      '<p class="empty spaced-copy">Queue is idle. New reviews appear here as soon as they enqueue.</p>';
  else
    html +=
      '<p class="warning spaced-copy">Work is waiting. Oldest ready job has waited ' +
      (q.oldestWaitMs == null ? 'an unknown time' : elapsed(q.oldestWaitMs)) +
      '. Capacity is ' +
      (w.activeReviews || 0) +
      '/' +
      (w.maxConcurrentReviews || 0) +
      '.</p>';
  html += '</div></div>';
  html +=
    '<div class="panel"><div class="section-head"><strong>' +
    (d.reviews || []).length +
    ' running client review(s)</strong><span class="note">' +
    (d.draining ? 'DRAINING · ' : '') +
    'auto-refresh every 3s · per full review, not per model pass</span></div>';
  if (!(d.reviews || []).length) {
    html +=
      '<div class="empty">No reviews running right now. When a client review starts, it appears here with elapsed time, checkout disk, and attributed process RAM.</div>';
  } else {
    html +=
      '<div class="live-row muted live-head"><div>Client / PR</div><div>Elapsed</div><div>Checkout disk</div><div>Review RAM</div><div>Codex children</div><div>Kind</div></div>';
    for (const r of d.reviews || []) {
      const client = r.tenantName || r.tenantSlug || r.tenantId;
      html += '<div class="live-row">';
      html +=
        '<div><span class="pulse"></span><div class="live-title">' +
        esc(client) +
        '</div><div class="mono">' +
        esc(r.owner) +
        '/' +
        esc(r.repo) +
        '#' +
        whole(r.pr) +
        ' @ ' +
        esc(String(r.headSha || '').slice(0, 7)) +
        '</div><div class="mini"><span class="badge">' +
        esc(r.planLabel || r.plan) +
        '</span> · run ' +
        (r.runId ? esc(String(r.runId).slice(0, 8)) : 'pending') +
        (r.deep ? ' · deep' : '') +
        '</div></div>';
      html +=
        '<div><strong>' +
        elapsed(r.elapsedMs) +
        '</strong><div class="mini">since ' +
        esc(String(r.startedAt || '').slice(11, 19)) +
        'Z</div></div>';
      html +=
        '<div><strong>' +
        bytes(r.checkoutDiskBytes) +
        '</strong><div class="mini">agent / runtime dirs</div></div>';
      html +=
        '<div><strong>' +
        bytes(r.totalRssBytes) +
        '</strong><div class="mini">node share ' +
        bytes(r.estimatedNodeRssShareBytes) +
        ' + children ' +
        bytes(r.childRssBytes) +
        '</div></div>';
      html +=
        '<div><strong>' +
        whole(r.childCount) +
        '</strong><div class="mini">' +
        (r.children || [])
          .map((c) => 'pid ' + whole(c.pid) + ' ' + bytes(c.rssBytes))
          .join('<br>') +
        '</div></div>';
      html +=
        '<div><span class="badge">' +
        esc(r.kind) +
        '</span><div class="mini">' +
        esc(r.action) +
        '</div></div>';
      html += '</div>';
    }
  }
  html +=
    '<p class="muted bottom-copy">Node worker RSS is shared across concurrent reviews; the panel shows an equal-share estimate plus any Codex/runtime child process RSS attributed to that review. LLM tokens and $ cost remain in the profitability section below.</p></div>';
  $('#live').innerHTML = html;
}
function renderCosts(d) {
  const o = d.overview || {};
  const avg = o.runsWithCost ? o.costUsd / o.runsWithCost : 0;
  const totalCalls = (d.byModel || []).reduce((s, m) => s + Number(m.calls || 0), 0);
  const avgCall = totalCalls ? o.costUsd / totalCalls : 0;
  const maxDaily = Math.max(1, ...(d.daily || []).map((x) => Number(x.costUsd || 0)));
  const maxRevenue = Math.max(1, ...(d.daily || []).map((x) => Number(x.actualRevenueUsd || 0)));
  const costPerRunSeries = (d.daily || []).map((day) => {
    const runs = Number(day.runs || 0);
    const cost = Number(day.costUsd || 0);
    return { day: day.day, value: runs ? cost / runs : 0, runs, cost };
  });
  const maxCostPerRun = Math.max(0.0001, ...costPerRunSeries.map((x) => x.value));
  const maxModelCalls = Math.max(1, ...(d.byModel || []).map((m) => Number(m.calls || 0)));
  let h =
    '<h2>Profit pulse · ' + esc(d.since.slice(0, 10)) + ' → ' + esc(d.until.slice(0, 10)) + '</h2>';
  h += '<div class="kpis">';
  h +=
    '<div class="kpi info"><div class="value">' +
    money(o.actualRevenueUsd) +
    '</div><div class="label">Actual Stripe revenue</div></div>';
  h +=
    '<div class="kpi"><div class="value">' +
    money(o.modeledMonthlyRevenueUsd) +
    '</div><div class="label">Modeled active MRR</div></div>';
  h +=
    '<div class="kpi warn"><div class="value">' +
    money(o.costUsd) +
    '</div><div class="label">LLM COGS</div></div>';
  h +=
    '<div class="kpi ' +
    (o.actualProfitUsd < 0 ? 'bad' : 'good') +
    '"><div class="value">' +
    money(o.actualProfitUsd) +
    '</div><div class="label">Contribution profit</div></div>';
  h +=
    '<div class="kpi ' +
    (o.actualMarginPct !== null && o.actualMarginPct < 0 ? 'bad' : 'good') +
    '"><div class="value">' +
    pct(o.actualMarginPct) +
    '</div><div class="label">Actual gross margin</div></div>';
  h +=
    '<div class="kpi"><div class="value">' +
    money(avg) +
    '</div><div class="label">Average cost / run</div></div>';
  h += '</div>';
  h +=
    '<div class="panel"><div class="coverage"><strong>' +
    o.runs +
    '</strong> runs · <strong>' +
    o.completedRuns +
    '</strong> completed · <strong>' +
    o.failedRuns +
    '</strong> failed · <strong>' +
    o.skippedRuns +
    '</strong> skipped · <strong>' +
    tokens(o.inputTokens) +
    '</strong> input · <strong>' +
    tokens(o.outputTokens) +
    '</strong> output · <strong>' +
    totalCalls +
    '</strong> model calls · avg <strong>' +
    money(avgCall) +
    '</strong> / call · telemetry coverage <strong>' +
    pct(o.telemetryCoveragePct) +
    '</strong> · legacy unattributed spend <strong>' +
    money(o.legacyCostUsd) +
    '</strong></div></div>';
  h +=
    '<div class="split"><div class="panel"><div class="section-head"><strong>Daily cash versus COGS</strong><span class="note">actual Stripe revenue · model spend</span></div><div class="trend">';
  for (const day of d.daily || []) {
    const cost = Number(day.costUsd || 0),
      rev = Number(day.actualRevenueUsd || 0);
    h +=
      '<div class="trend-row"><span class="mono">' +
      esc(day.day.slice(5)) +
      '</span><div><div class="track" title="COGS ' +
      money(cost) +
      '"><progress class="meter" max="100" value="' +
      Math.min(100, (cost / maxDaily) * 100) +
      '"></progress></div><div class="track top-gap" title="Revenue ' +
      money(rev) +
      '"><progress class="meter revenue" max="100" value="' +
      Math.min(100, (rev / maxRevenue) * 100) +
      '"></progress></div></div><span class="right">' +
      money(rev) +
      ' / ' +
      money(cost) +
      '</span></div>';
  }
  h +=
    '</div></div><div class="panel"><div class="section-head"><strong>Margin controls</strong><span class="note">operator attention</span></div>';
  if (o.actualRevenueUsd <= 0)
    h +=
      '<p class="warning">No paid Stripe revenue is recorded in this window. Use “Sync Stripe revenue” before treating modeled margin as collected cash.</p>';
  if ((o.nonUsdRevenue || []).length)
    h +=
      '<p class="warning">Revenue in non-USD currencies is excluded from USD profitability: ' +
      (o.nonUsdRevenue || [])
        .map((x) => currencyMoney(x.currency, Number(x.amountCents || 0) / 100))
        .map(esc)
        .join(', ') +
      '.</p>';
  if (o.legacyCostUsd > 0)
    h +=
      '<p class="warning">Legacy runs contain ' +
      money(o.legacyCostUsd) +
      ' of aggregate spend without model attribution.</p>';
  if (o.failedRuns > 0)
    h +=
      '<p class="warning">' +
      o.failedRuns +
      ' failed runs are included so provider spend cannot disappear from margin.</p>';
  if (o.actualProfitUsd < 0)
    h +=
      '<p class="negative">The selected window is contribution-negative. Review the client and model tables below before increasing capacity.</p>';
  if (o.actualRevenueUsd > 0 && o.actualProfitUsd >= 0 && o.legacyCostUsd === 0)
    h +=
      '<p class="positive">No contribution-loss or telemetry-gap alert is active for this window.</p>';
  h +=
    '<p class="muted">Modeled active-plan contribution: <strong>' +
    money(o.modeledProfitUsd) +
    '</strong> · modeled margin <strong>' +
    pct(o.modeledMarginPct) +
    '</strong>. This is recurring-plan economics, not cash collected.</p><p class="muted">Fixed overhead: <strong>' +
    money(o.monthlyFixedCostUsd) +
    '/mo</strong> · allocated overhead: <strong>' +
    money(o.allocatedFixedCostUsd) +
    '</strong> · actual net profit: <strong class="' +
    marginClass(o.actualNetProfitUsd) +
    '">' +
    money(o.actualNetProfitUsd) +
    '</strong>.</p></div></div>';
  h +=
    '<div class="split"><div class="panel"><div class="section-head"><strong>Daily cost per run</strong><span class="note">intensity of LLM spend</span></div><div class="trend">';
  for (const row of costPerRunSeries) {
    h +=
      '<div class="trend-row"><span class="mono">' +
      esc(String(row.day).slice(5)) +
      '</span><div class="track" title="' +
      money(row.value) +
      ' over ' +
      row.runs +
      ' run(s)"><progress class="meter" max="100" value="' +
      Math.min(100, (row.value / maxCostPerRun) * 100) +
      '"></progress></div><span class="right">' +
      money(row.value) +
      '</span></div>';
  }
  if (!costPerRunSeries.length) h += '<div class="empty">No daily spend yet.</div>';
  h +=
    '</div></div><div class="panel"><div class="section-head"><strong>Calls by model</strong><span class="note">window total ' +
    totalCalls +
    ' · avg ' +
    money(avgCall) +
    '/call</span></div><div class="trend">';
  for (const m of d.byModel || []) {
    const calls = Number(m.calls || 0);
    const perCall = calls ? Number(m.costUsd || 0) / calls : 0;
    h +=
      '<div class="trend-row"><span class="mono" title="' +
      esc(m.model) +
      '">' +
      esc(String(m.model).slice(0, 14)) +
      '</span><div class="track" title="' +
      calls +
      ' calls · ' +
      money(perCall) +
      '/call"><progress class="meter" max="100" value="' +
      Math.min(100, (calls / maxModelCalls) * 100) +
      '"></progress></div><span class="right">' +
      calls +
      ' · ' +
      money(perCall) +
      '</span></div>';
  }
  if (!(d.byModel || []).length) h += '<div class="empty">No instrumented model calls yet.</div>';
  h += '</div></div></div>';
  h +=
    '<h2>Fixed operating costs</h2><div class="panel"><div class="section-head"><strong>Monthly overhead inputs</strong><span class="note">server, monitoring, support, fees, and other fixed costs</span></div><form id="costForm" class="toolbar cost-form"><input name="category" placeholder="Category" required maxlength="80"><input name="amount" type="number" min="0" step="0.01" placeholder="USD / month" required><input class="cost-note" name="note" placeholder="Note (optional)" maxlength="240"><button type="submit">Save cost</button></form><div class="table-wrap"><table><tr><th>Category</th><th class="num">Monthly amount</th><th>Note</th><th></th></tr>';
  for (const cost of d.platformCosts || []) {
    h +=
      '<tr><td>' +
      esc(cost.category) +
      '</td><td class="num">' +
      money(Number(cost.amountCents || 0) / 100) +
      '</td><td class="muted">' +
      esc(cost.note || '') +
      '</td><td class="right"><button class="secondary" data-delete-cost="' +
      esc(cost.category) +
      '" type="button">Remove</button></td></tr>';
  }
  if (!(d.platformCosts || []).length)
    h +=
      '<tr><td colspan="4" class="empty">Add monthly operating costs to see net profit after infrastructure overhead.</td></tr>';
  h += '</table></div></div>';
  h +=
    '<h2>Model economics</h2><div class="panel"><table><tr><th>Model</th><th>Provider / tier</th><th class="num">Calls</th><th class="num">Runs</th><th class="num">Input</th><th class="num">Output</th><th class="num">Cost</th><th class="num">Avg / call</th><th class="num">Avg / run</th></tr>';
  for (const m of d.byModel || []) {
    const calls = whole(m.calls);
    const runs = whole(m.runs);
    h +=
      '<tr><td><strong>' +
      esc(m.model) +
      '</strong></td><td><span class="badge">' +
      esc(m.provider) +
      '</span> <span class="muted">' +
      esc(m.tier) +
      '</span></td><td class="num">' +
      calls +
      '</td><td class="num">' +
      runs +
      '</td><td class="num">' +
      tokens(m.inputTokens) +
      '</td><td class="num">' +
      tokens(m.outputTokens) +
      '</td><td class="num"><strong>' +
      money(m.costUsd) +
      '</strong></td><td class="num">' +
      money(calls ? number(m.costUsd) / calls : 0) +
      '</td><td class="num">' +
      money(runs ? number(m.costUsd) / runs : 0) +
      '</td></tr>';
  }
  if (!(d.byModel || []).length)
    h +=
      '<tr><td colspan="9" class="empty">No instrumented model usage exists in this range yet.</td></tr>';
  h += '</table></div>';
  h +=
    '<h2>Client profitability</h2><div class="panel"><table><tr><th>Workspace</th><th>Plan</th><th class="num">Runs</th><th class="num">Actual revenue</th><th class="num">Modeled MRR</th><th class="num">COGS</th><th class="num">Profit</th><th class="num">Margin</th></tr>';
  for (const t of d.byTenant || []) {
    const cls = marginClass(t.actualMarginPct);
    h +=
      '<tr><td><strong>' +
      esc(t.name || t.slug) +
      '</strong><div class="mono">' +
      esc(t.slug) +
      '</div></td><td><span class="badge">' +
      esc(t.planLabel || t.plan) +
      '</span></td><td class="num">' +
      whole(t.runs) +
      '</td><td class="num">' +
      money(t.actualRevenueUsd) +
      '</td><td class="num">' +
      money(t.modeledMonthlyRevenueUsd) +
      '</td><td class="num">' +
      money(t.costUsd) +
      '</td><td class="num ' +
      cls +
      '">' +
      money(t.actualProfitUsd) +
      '</td><td class="num ' +
      cls +
      '">' +
      pct(t.actualMarginPct) +
      '</td></tr>';
  }
  if (!(d.byTenant || []).length)
    h += '<tr><td colspan="8" class="empty">No client activity exists in this range.</td></tr>';
  h += '</table></div>';
  h += '<h2>Every review run · ' + (d.recentRuns || []).length + ' loaded</h2><div class="panel">';
  for (const r of d.recentRuns || []) {
    const cost = number(r.actualCostUsd);
    h +=
      '<details class="run"><summary><span><strong>#' +
      whole(r.pr) +
      ' ' +
      esc(r.repo) +
      '</strong><div class="run-meta">' +
      esc(
        String(r.createdAt || '')
          .slice(0, 16)
          .replace('T', ' '),
      ) +
      ' · ' +
      esc(r.owner) +
      '</div></span><span class="run-meta">' +
      esc(r.status) +
      '</span><span class="run-meta">' +
      (r.legacyCost ? 'legacy aggregate' : 'instrumented') +
      '</span><span class="run-cost">' +
      money(cost) +
      '</span></summary><div class="run-table-wrap"><table><tr><th>Pass</th><th>Model</th><th>Provider / tier</th><th class="num">Input</th><th class="num">Output</th><th class="num">Cost</th><th>Source</th></tr>';
    if (r.usage && r.usage.length) {
      for (const u of r.usage) {
        h +=
          '<tr><td>' +
          esc(u.passName || 'model call') +
          '</td><td><strong>' +
          esc(u.model) +
          '</strong></td><td>' +
          esc(u.provider) +
          ' / ' +
          esc(u.tier) +
          '</td><td class="num">' +
          tokens(u.inputTokens) +
          '</td><td class="num">' +
          tokens(u.outputTokens) +
          '</td><td class="num">' +
          money(u.costUsd) +
          '</td><td>' +
          esc(u.tokenSource) +
          '</td></tr>';
      }
    } else
      h +=
        '<tr><td colspan="7" class="empty">Legacy aggregate only; model-level attribution was not persisted for this run.</td></tr>';
    h += '</table></div></details>';
  }
  if (!(d.recentRuns || []).length)
    h += '<div class="empty">No review runs exist in the selected window.</div>';
  h += '</div>';
  $('#costs').innerHTML = h;
  $('#costForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      await api('/superadmin/api/operating-costs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          category: f.get('category'),
          amountCents: Math.round(Number(f.get('amount')) * 100),
          note: f.get('note'),
        }),
      });
      await load();
    } catch (err) {
      $('#status').textContent = err.message;
    }
  });
  document.querySelectorAll('[data-delete-cost]').forEach((button) =>
    button.addEventListener('click', async () => {
      try {
        await api(
          '/superadmin/api/operating-costs/' + encodeURIComponent(button.dataset.deleteCost),
          { method: 'DELETE' },
        );
        await load();
      } catch (err) {
        $('#status').textContent = err.message;
      }
    }),
  );
}
function render(b) {
  if (b.empty || !b.generatedAt) {
    $('#content').innerHTML =
      '<h2>Catch rate scoreboard</h2><div class="panel"><p class="warning">No scoreboard yet. Click <strong>Rebuild scoreboard</strong> once to mine GitHub PR comments (no LLM cost). Costs and live monitor above still work.</p><div class="toolbar toolbar-spaced"><label class="muted">Config-era snapshot</label><select id="scoreHistory" aria-label="Scoreboard history"><option value="">Current (empty)</option></select></div></div>';
    loadScoreHistory();
    return;
  }
  const bots = Object.entries(b.bots || {}).sort((x, y) => y[1].clustersHit - x[1].clustersHit);
  let h =
    '<h2>Catch rate · ' +
    esc(b.repo) +
    ' · ' +
    b.prsAnalyzed +
    ' PRs · ' +
    (b.clusters?.total || 0) +
    ' defect clusters · rules ' +
    esc(b.rulesHash || '?') +
    ' · ' +
    esc(b.generatedAt) +
    '</h2>';
  h +=
    '<div class="panel toolbar toolbar-panel"><label class="muted">Config-era snapshot</label><select id="scoreHistory" aria-label="Scoreboard history"><option value="">Current</option></select><span class="note muted">Compare rebuilds stamped with different rules hashes.</span></div>';
  if (b.trend) {
    const t = b.trend;
    const d = t.recent.orvexCatchPct - t.older.orvexCatchPct;
    h +=
      '<div class="panel">Trend — Orvex catch rate: recent half (' +
      t.recent.prs +
      ' PRs) <strong>' +
      t.recent.orvexCatchPct +
      '%</strong> vs older half (' +
      t.older.prs +
      ' PRs) <strong>' +
      t.older.orvexCatchPct +
      '%</strong> → <span class="' +
      (d >= 0 ? 'unique' : 'miss') +
      '">' +
      (d >= 0 ? '+' : '') +
      d +
      ' pts</span>.</div>';
  }
  h +=
    '<div class="panel"><table><tr><th>Bot</th><th>Findings</th><th>Clusters hit</th><th>Catch %</th><th>Unique catches</th><th>PRs w/ findings</th></tr>';
  for (const [name, s] of bots) {
    h +=
      '<tr><td><strong>' +
      esc(name) +
      '</strong></td><td>' +
      s.findings +
      '</td><td>' +
      s.clustersHit +
      '</td><td>' +
      (b.clusters.total ? Math.round((100 * s.clustersHit) / b.clusters.total) : 0) +
      '%</td><td class="unique">' +
      s.uniqueClusters +
      '</td><td>' +
      s.prsWithFindings +
      '</td></tr>';
  }
  h += '</table></div>';
  h +=
    '<h2 class="miss">Orvex missed (' +
    (b.clusters?.orvexMissed || []).length +
    ') — each is a candidate rule/lens</h2><div class="panel"><table><tr><th>PR</th><th>Location</th><th>Sev</th><th>Bots</th><th>Excerpt</th></tr>';
  for (const m of b.clusters?.orvexMissed || []) {
    h +=
      '<tr><td>#' +
      m.pr +
      '</td><td class="mono">' +
      esc(m.path || '?') +
      ':' +
      (m.line ?? '?') +
      '</td><td>' +
      esc(m.severity || '—') +
      '</td><td>' +
      m.bots.map(esc).join(', ') +
      '</td><td class="mono">' +
      esc(m.excerpt) +
      '</td></tr>';
  }
  h += '</table></div>';
  h +=
    '<h2 class="unique">Only Orvex caught (' +
    (b.clusters?.orvexUnique || []).length +
    ') — marketing ammo</h2><div class="panel"><table><tr><th>PR</th><th>Location</th><th>Sev</th><th>Excerpt</th></tr>';
  for (const m of b.clusters?.orvexUnique || []) {
    h +=
      '<tr><td>#' +
      m.pr +
      '</td><td class="mono">' +
      esc(m.path || '?') +
      ':' +
      (m.line ?? '?') +
      '</td><td>' +
      esc(m.severity || '—') +
      '</td><td class="mono">' +
      esc(m.excerpt) +
      '</td></tr>';
  }
  h += '</table></div>';
  h +=
    '<h2>Per-PR finding counts</h2><div class="panel"><table><tr><th>PR</th><th>Title</th><th>State</th><th>Counts</th></tr>';
  for (const p of b.perPr || []) {
    const c =
      Object.entries(p.counts || {})
        .map(([k, v]) => k + ':' + v)
        .join('  ') || '—';
    h +=
      '<tr><td>#' +
      p.pr +
      '</td><td>' +
      esc(String(p.title || '').slice(0, 70)) +
      '</td><td>' +
      esc(p.state) +
      '</td><td class="mono">' +
      esc(c) +
      '</td></tr>';
  }
  h += '</table></div>';
  $('#content').innerHTML = h;
  loadScoreHistory();
}
async function loadScoreHistory() {
  const sel = $('#scoreHistory');
  if (!sel) return;
  try {
    const data = await api('/superadmin/api/scoreboard/history');
    const current = sel.value;
    sel.innerHTML = '<option value="">Current</option>';
    for (const s of data.snapshots || []) {
      const label = (s.at || s.file) + ' · rules ' + (s.rulesHash || '?');
      const opt = document.createElement('option');
      opt.value = s.file;
      opt.textContent = label;
      sel.appendChild(opt);
    }
    if (current) sel.value = current;
    sel.addEventListener('change', async () => {
      if (!sel.value) {
        const cur = await api('/superadmin/api/scoreboard');
        render(cur);
        return;
      }
      try {
        render(await api('/superadmin/api/scoreboard/history/' + encodeURIComponent(sel.value)));
      } catch (e) {
        $('#status').textContent = e.message;
      }
    });
  } catch (e) {
    /* history is optional */
  }
}
function renderDeep(d) {
  let h =
    '<h2>Deep vs Normal · ' +
    d.totals.normalRuns +
    ' normal / ' +
    d.totals.deepRuns +
    ' deep runs · ' +
    esc(d.generatedAt) +
    '</h2>';
  h +=
    '<div class="panel"><table><tr><th></th><th>Avg cost</th><th>Avg duration</th><th>Avg new findings/run</th></tr>';
  h +=
    '<tr><td><strong>Normal</strong></td><td>$' +
    d.totals.avgCostNormal.toFixed(3) +
    '</td><td>' +
    Math.round(d.totals.avgDurationSNormal) +
    's</td><td>' +
    d.totals.avgNewFindingsNormal.toFixed(1) +
    '</td></tr>';
  h +=
    '<tr><td><strong>Deep</strong></td><td>$' +
    d.totals.avgCostDeep.toFixed(3) +
    '</td><td>' +
    Math.round(d.totals.avgDurationSDeep) +
    's</td><td>' +
    d.totals.avgNewFindingsDeep.toFixed(1) +
    '</td></tr></table></div>';
  h +=
    '<div class="panel">A/B pairs (normal first, then deep, same commit): <strong>' +
    d.pairs.length +
    '</strong> · deep added a P1/P2 beyond normal on <strong class="' +
    (d.pairs.length && d.pairsWhereDeepAddedSevere / d.pairs.length >= 0.5 ? 'unique' : 'miss') +
    '">' +
    d.pairsWhereDeepAddedSevere +
    ' / ' +
    d.pairs.length +
    '</strong> pairs · unpaired deep runs (no prior normal, not marginal): ' +
    d.unpairedDeepRuns +
    '</div>';
  if (d.pairs.length) {
    h +=
      '<div class="panel"><table><tr><th>PR@commit</th><th>Normal found (P1/P2/P3/info)</th><th>Deep ADDED (P1/P2/P3/info)</th><th>Normal $</th><th>Deep $</th></tr>';
    const f = (x) => x.P1 + '/' + x.P2 + '/' + x.P3 + '/' + x.info;
    for (const p of d.pairs) {
      h +=
        '<tr><td class="mono">#' +
        p.pr +
        '@' +
        esc(p.headSha.slice(0, 7)) +
        '</td><td>' +
        f(p.normal.found) +
        '</td><td class="' +
        (p.deepMarginal.found.P1 + p.deepMarginal.found.P2 > 0 ? 'unique' : '') +
        '">' +
        f(p.deepMarginal.found) +
        '</td><td>$' +
        p.normal.costUsd.toFixed(3) +
        '</td><td>$' +
        p.deepMarginal.costUsd.toFixed(3) +
        '</td></tr>';
    }
    h += '</table></div>';
  }
  $('#deep').innerHTML = h;
}
function renderDeadLetters(payload) {
  const root = $('#deadLetters');
  if (!root) return;
  const rows = payload.deadLetters || [];
  let html = '<h2 id="deadLettersTitle">Dead-lettered work</h2><div class="panel">';
  if (!payload.replayAvailable)
    html += '<p class="empty">This queue backend does not expose durable dead-letter replay.</p>';
  else if (!rows.length)
    html += '<p class="empty">No dead-lettered jobs require operator action.</p>';
  else
    html += rows
      .map(
        (row) =>
          '<div class="dead-letter-row"><div><strong>' +
          esc(row.owner) +
          '/' +
          esc(row.repository) +
          ' #' +
          Number(row.pullRequest) +
          '</strong><div class="dead-letter-meta"><span>' +
          esc(row.kind) +
          ' · ' +
          esc(row.action) +
          '</span><span class="failure-code">' +
          esc(row.failureCode) +
          '</span><span>' +
          esc(row.failedAt) +
          '</span><span>' +
          Number(row.attempts) +
          ' attempt(s)</span></div></div><button class="secondary" type="button" data-replay-dead-letter="' +
          esc(row.id) +
          '">Replay once</button></div>',
      )
      .join('');
  root.innerHTML = html + '</div>';
  root.querySelectorAll('[data-replay-dead-letter]').forEach((button) =>
    button.addEventListener('click', async () => {
      button.disabled = true;
      $('#status').textContent = 'replaying dead-lettered job…';
      try {
        await api(
          '/superadmin/api/dead-letters/' +
            encodeURIComponent(button.dataset.replayDeadLetter) +
            '/replay',
          { method: 'POST' },
        );
        $('#status').textContent = 'dead-lettered job replayed';
        await loadDeadLetters();
      } catch (e) {
        $('#status').textContent = e.message || 'replay failed';
        button.disabled = false;
      }
    }),
  );
}
async function loadDeadLetters() {
  try {
    renderDeadLetters(await api('/superadmin/api/dead-letters'));
  } catch (e) {
    const root = $('#deadLetters');
    if (root)
      root.innerHTML =
        '<h2 id="deadLettersTitle">Dead-lettered work</h2><div class="panel warning">Dead-letter monitor unavailable: ' +
        esc(e.message) +
        '</div>';
  }
}
function renderPublicationClaims(payload) {
  const root = $('#publicationClaims');
  if (!root) return;
  const claims = payload.claims || [];
  const resolutions = payload.resolutions || [];
  let html =
    '<h2 id="publicationClaimsTitle">Ambiguous GitHub publications</h2><div class="panel">';
  if (!claims.length)
    html += '<p class="empty">No abandoned publication claims require an operator decision.</p>';
  else
    html += claims
      .map(
        (row) =>
          '<div class="dead-letter-row"><div><strong>' +
          esc(row.owner) +
          '/' +
          esc(row.repo) +
          ' #' +
          Number(row.pr) +
          '</strong><div class="dead-letter-meta"><span class="failure-code">' +
          esc(row.artifactKey) +
          '</span><span>claimed ' +
          esc(row.claimedAt) +
          '</span><span>run ' +
          esc(row.runStatus) +
          '</span></div></div><div class="toolbar"><button class="secondary" type="button" data-publication-retry="' +
          esc(row.runId) +
          '" data-tenant="' +
          esc(row.tenantId) +
          '" data-artifact="' +
          esc(row.artifactKey) +
          '">Allow retry</button><button type="button" data-publication-published="' +
          esc(row.runId) +
          '" data-tenant="' +
          esc(row.tenantId) +
          '" data-artifact="' +
          esc(row.artifactKey) +
          '">Mark published</button></div></div>',
      )
      .join('');
  if (resolutions.length) {
    html +=
      '<details class="run"><summary><strong>Recent decisions</strong><span class="run-meta">' +
      resolutions.length +
      ' recorded</span></summary><div class="table-wrap"><table><tr><th>Artifact</th><th>Decision</th><th>Actor</th><th>Reason</th><th>Time</th></tr>' +
      resolutions
        .map(
          (row) =>
            '<tr><td class="mono">' +
            esc(row.artifactKey) +
            '</td><td>' +
            esc(row.action) +
            '</td><td>' +
            esc(row.actor) +
            '</td><td>' +
            esc(row.reason) +
            '</td><td>' +
            esc(row.resolvedAt) +
            '</td></tr>',
        )
        .join('') +
      '</table></div></details>';
  }
  root.innerHTML = html + '</div>';
  root.querySelectorAll('[data-publication-retry]').forEach((button) =>
    button.addEventListener('click', async () => {
      const reason = prompt('Audit reason for allowing a retry');
      if (!reason) return;
      if (
        !confirm('Allow a later explicit retry? This does not call GitHub or requeue the review.')
      )
        return;
      await resolvePublication(button, 'retry', reason);
    }),
  );
  root.querySelectorAll('[data-publication-published]').forEach((button) =>
    button.addEventListener('click', async () => {
      const raw = prompt('Verified GitHub result as JSON. Use null for reply/runtime comments.');
      if (raw === null) return;
      let result;
      try {
        result = JSON.parse(raw);
      } catch {
        $('#status').textContent = 'GitHub result must be valid JSON';
        return;
      }
      const reason = prompt('Audit reason and GitHub evidence');
      if (!reason) return;
      if (!confirm('Mark this artifact as already published? This prevents any automatic replay.'))
        return;
      await resolvePublication(button, 'mark-published', reason, result);
    }),
  );
}
async function resolvePublication(button, action, reason, result) {
  button.disabled = true;
  $('#status').textContent = 'recording publication decision…';
  const body = {
    tenantId: button.dataset.tenant,
    runId:
      action === 'retry' ? button.dataset.publicationRetry : button.dataset.publicationPublished,
    artifactKey: button.dataset.artifact,
    action,
    reason,
  };
  if (action === 'mark-published') body.result = result;
  try {
    await api('/superadmin/api/publication-claims/resolve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    $('#status').textContent = 'publication decision recorded';
    await loadPublicationClaims();
  } catch (e) {
    $('#status').textContent = e.message || 'publication decision failed';
    button.disabled = false;
  }
}
async function loadPublicationClaims() {
  try {
    renderPublicationClaims(await api('/superadmin/api/publication-claims'));
  } catch (e) {
    const root = $('#publicationClaims');
    if (root)
      root.innerHTML =
        '<h2 id="publicationClaimsTitle">Ambiguous GitHub publications</h2><div class="panel warning">Publication claim monitor unavailable: ' +
        esc(e.message) +
        '</div>';
  }
}
async function loadLive() {
  liveRequest?.abort();
  liveRequest = new AbortController();
  try {
    renderLive(await api('/superadmin/api/active-reviews', { signal: liveRequest.signal }));
  } catch (e) {
    if (e.name !== 'AbortError' && $('#live'))
      $('#live').innerHTML =
        '<div class="panel warning">Live monitor unavailable: ' + esc(e.message) + '</div>';
  }
}
async function load() {
  $('#status').textContent = 'loading…';
  const days = $('#range').value;
  try {
    await Promise.all([
      loadLive(),
      loadDeadLetters(),
      loadPublicationClaims(),
      api('/superadmin/api/costs?days=' + encodeURIComponent(days) + '&limit=5000').then(
        renderCosts,
      ),
      api('/superadmin/api/scoreboard').then(render),
      api('/superadmin/api/deep-scorecard').then(renderDeep),
    ]);
    $('#status').textContent = '';
  } catch (e) {
    $('#status').textContent = e.message;
  }
}
$('#rebuild').addEventListener('click', async () => {
  $('#rebuild').disabled = true;
  $('#status').textContent = 'rebuilding — reading PR comments from GitHub…';
  try {
    render(await api('/superadmin/api/scoreboard/rebuild?prs=80', { method: 'POST' }));
    $('#status').textContent = 'rebuilt';
  } catch (e) {
    $('#status').textContent = e.message;
  } finally {
    $('#rebuild').disabled = false;
  }
});
$('#refresh').addEventListener('click', load);
$('#range').addEventListener('change', load);
$('#syncRevenue').addEventListener('click', async () => {
  $('#syncRevenue').disabled = true;
  $('#status').textContent = 'syncing Stripe invoices…';
  try {
    const result = await api('/superadmin/api/revenue/sync', { method: 'POST' });
    $('#status').textContent =
      'Stripe synced ' +
      result.synced +
      ' invoice(s)' +
      (result.errors.length ? ' · ' + result.errors.length + ' error(s)' : '');
    await load();
  } catch (e) {
    $('#status').textContent = e.message;
  } finally {
    $('#syncRevenue').disabled = false;
  }
});
$('#security').addEventListener('click', () => {
  location.href = '/settings/security';
});
load();
setInterval(() => {
  if (document.visibilityState === 'visible') loadLive();
}, 3000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') liveRequest?.abort();
  else loadLive();
});
