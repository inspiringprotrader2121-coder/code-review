const SLUG = document.body.dataset.workspaceSlug;
const SHOW_LLM_COST = document.body.dataset.showLlmCost === 'true';
if (!SLUG) throw new Error('Dashboard boot data is missing');
const api = (p, options = {}) =>
  fetch('/api/workspaces/' + encodeURIComponent(SLUG) + p, {
    credentials: 'same-origin',
    ...options,
  }).then((r) => (r.ok ? r.json() : r.json().then((e) => Promise.reject(e))));
async function buyCredits(amountCents) {
  try {
    const r = await fetch('/api/workspaces/' + encodeURIComponent(SLUG) + '/billing/credits', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amountCents }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      alert(body.error || 'Could not start credit checkout');
      return;
    }
    if (body.url) location.href = body.url;
    else alert('Stripe did not return a checkout URL');
  } catch (e) {
    alert('Could not start credit checkout');
  }
}
const esc = (x) =>
  String(x == null ? '' : x).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const finiteNumber = (value, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};
const wholeNumber = (value, fallback = 0) => Math.max(0, Math.trunc(finiteNumber(value, fallback)));
const sevCls = (s) => ({ P1: 'p1', P2: 'p2', P3: 'p3' })[s] || 'muted';
const runCls = (s) =>
  s === 'completed' ? 'done' : s === 'failed' ? 'fail' : s === 'running' ? 'run' : 'queued';
const runReason = (r) => {
  if (r.skipReason === 'pr_closed_mid_run') return 'PR closed during review';
  if (r.skipReason === 'provider_not_configured') return 'Provider unavailable';
  if (r.skipReason) return String(r.skipReason).replaceAll('_', ' ');
  const error = String(r.error || '');
  if (/^review incomplete:/i.test(error))
    return 'Partial review posted — one or more required passes did not complete';
  if (r.status !== 'failed') return '';
  if (/review input coverage incomplete/i.test(error))
    return 'GitHub diff incomplete — no model calls were made';
  if (/required review (?:coverage unit|lens).*did not complete|completed fewer than/i.test(error))
    return 'Required model pass did not complete — retry';
  if (/wall-clock cap|produced no container output/i.test(error))
    return 'Provider timed out before verdict — retry';
  if (/fork failed|resource temporarily unavailable|sandbox slot/i.test(error))
    return 'Review sandbox was unavailable — retry';
  if (/truncated|stop_reason=max_tokens/i.test(error))
    return 'Provider response exceeded its output budget — retry';
  if (/rate.?limit|\b429\b|quota/i.test(error)) return 'Provider temporarily rate-limited — retry';
  return 'Review pipeline failed — retry';
};
const runChip = (s, reason) => {
  const status = typeof s === 'string' && s ? s : 'queued';
  return (
    '<span class="chip ' +
    runCls(status) +
    '"' +
    (reason ? ' title="' + esc(reason) + '"' : '') +
    '><span class="cd"></span>' +
    esc(status[0].toUpperCase() + status.slice(1)) +
    (reason ? ' <small>' + esc(reason) + '</small>' : '') +
    '</span>'
  );
};
const rel = (iso) => {
  const time = typeof iso === 'string' ? new Date(iso).getTime() : NaN;
  if (!Number.isFinite(time)) return '—';
  const d = (Date.now() - time) / 1000;
  if (d < 60) return 'just now';
  if (d < 3600) return Math.floor(d / 60) + 'm ago';
  if (d < 86400) return Math.floor(d / 3600) + 'h ago';
  return Math.floor(d / 86400) + 'd ago';
};
const dur = (ms) => {
  const sec = Math.round(finiteNumber(ms) / 1000);
  if (sec <= 0) return '—';
  return sec < 60
    ? sec + 's'
    : Math.floor(sec / 60) + 'm ' + String(sec % 60).padStart(2, '0') + 's';
};
const estimatedUsd = (n, estimated = false) => {
  if (n == null) return estimated ? 'usage incomplete*' : '—';
  const amount = finiteNumber(n);
  // A zero total alongside an unreported terminal provider attempt is unknown,
  // not a zero-cost review. Keep it distinct from a partial known total.
  if (estimated && amount === 0) return 'usage incomplete*';
  return (estimated ? '~' : '') + '$' + amount.toFixed(2) + (estimated ? '*' : '');
};
const repoShort = (fn) => String(fn || '').split('/');

// —— theme toggle (persisted) ——
(function () {
  const root = document.documentElement,
    btn = document.getElementById('themeBtn'),
    lab = document.getElementById('themeLabel');
  const sysDark = () =>
    window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const eff = () => {
    const t = root.getAttribute('data-theme');
    return t === 'dark' ? true : t === 'light' ? false : sysDark();
  };
  const sync = () => {
    const d = eff();
    root.classList.toggle('is-dark', d);
    btn.setAttribute('aria-pressed', String(d));
    if (lab) lab.textContent = d ? 'Dark' : 'Light';
  };
  btn.addEventListener('click', () => {
    const next = eff() ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    try {
      localStorage.setItem('orvex-theme', next);
    } catch (e) {}
    sync();
  });
  window.matchMedia &&
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (!root.getAttribute('data-theme')) sync();
    });
  sync();
})();

document.getElementById('wsName').textContent = SLUG;
document.getElementById('wsSlug').textContent = SLUG;
document.getElementById('wsAvatar').textContent = SLUG.slice(0, 1).toUpperCase();
document.getElementById('avatar').textContent = SLUG.slice(0, 1).toUpperCase();
document.getElementById('crumbWs').textContent = SLUG;
document.getElementById('refresh').addEventListener('click', loadAll);
document
  .querySelectorAll('[data-buy-credits]')
  .forEach((button) =>
    button.addEventListener('click', () => buyCredits(Number(button.dataset.buyCredits))),
  );

const titles = {
  overview: 'Overview',
  pulls: 'Pull requests',
  findings: 'Findings',
  reviews: 'Review runs',
  repos: 'Repositories',
  installs: 'Installations',
  settings: 'Settings',
};
function showView(v) {
  document.querySelectorAll('.nav [data-view],.mobile-nav button[data-view]').forEach((x) => {
    const selected = x.dataset.view === v;
    x.classList.toggle('active', selected);
    if (x.getAttribute('role') === 'tab') {
      x.setAttribute('aria-selected', String(selected));
      x.tabIndex = selected ? 0 : -1;
    }
  });
  document.querySelectorAll('.view').forEach((x) => x.classList.remove('active'));
  document.getElementById('v-' + v).classList.add('active');
  document.getElementById('viewTitle').textContent = titles[v];
  document.getElementById('crumbView').textContent = titles[v];
  document.getElementById('viewTitle').focus();
  if (v === 'repos') loadRepos();
  if (v === 'reviews') loadReviews();
  if (v === 'settings') loadSettings();
  if (v === 'installs') loadInstalls();
}
document
  .querySelectorAll('[data-view]')
  .forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
const tabs = [...document.querySelectorAll('.nav [role="tab"]')];
tabs.forEach((tab, index) =>
  tab.addEventListener('keydown', (event) => {
    let nextIndex;
    if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = tabs.length - 1;
    else if (event.key === 'ArrowDown' || event.key === 'ArrowRight')
      nextIndex = (index + 1) % tabs.length;
    else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft')
      nextIndex = (index - 1 + tabs.length) % tabs.length;
    else return;
    event.preventDefault();
    const next = tabs[nextIndex];
    showView(next.dataset.view);
    next.focus();
  }),
);

// —— sparkline ——
function spark(vals, color) {
  if (!vals.length) vals = [0, 0];
  const W = 120,
    H = 34,
    max = Math.max(1, ...vals),
    min = Math.min(...vals),
    span = Math.max(1, max - min);
  const pts = vals.map((v, i) => {
    const x = vals.length > 1 ? (i / (vals.length - 1)) * W : W;
    const y = H - 4 - ((v - min) / span) * (H - 8);
    return x.toFixed(1) + ',' + y.toFixed(1);
  });
  const last = pts[pts.length - 1].split(',');
  return (
    '<svg viewBox="0 0 ' +
    W +
    ' ' +
    H +
    '" preserveAspectRatio="none" aria-hidden="true"><polyline points="' +
    pts.join(' ') +
    '" fill="none" stroke="' +
    color +
    '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="' +
    last[0] +
    '" cy="' +
    last[1] +
    '" r="2.6" fill="' +
    color +
    '"/></svg>'
  );
}
function deltaEl(cur, prev, unit, invert) {
  if (prev === 0 && cur === 0) return '<span class="delta flat">±0</span>';
  const diff = cur - prev;
  const good = invert ? diff < 0 : diff > 0;
  const cls = diff === 0 ? 'flat' : good ? 'up' : 'down';
  const arrow = diff === 0 ? '±' : diff > 0 ? '▲' : '▼';
  const mag =
    unit === '%'
      ? Math.abs(prev ? Math.round((diff / Math.max(1, prev)) * 100) : 0) + '%'
      : Math.abs(diff);
  return '<span class="delta ' + cls + '">' + arrow + ' ' + mag + '</span>';
}

// —— per-day series from real review runs ——
let seriesCache = null;
let overviewRequest;
async function series() {
  if (seriesCache) return seriesCache;
  const { reviews } = await api('/reviews?limit=300');
  const days = [];
  const idx = {};
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    const key = d.toISOString().slice(0, 10);
    idx[key] = days.length;
    days.push({
      key,
      label: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
      reviews: 0,
      bugs: 0,
      cost: 0,
      durSum: 0,
      durN: 0,
    });
  }
  reviews.forEach((r) => {
    const k = (r.createdAt || '').slice(0, 10);
    if (!(k in idx)) return;
    const d = days[idx[k]];
    if (r.status === 'completed') {
      d.reviews++;
      d.bugs += wholeNumber(r.findingsNew);
      d.cost += finiteNumber(r.costUsd);
      if (finiteNumber(r.durationMs) > 0) {
        d.durSum += finiteNumber(r.durationMs);
        d.durN++;
      }
    }
  });
  seriesCache = { days, all: reviews };
  return seriesCache;
}
const half = (arr, f) => ({
  prev: arr.slice(0, 7).reduce((a, d) => a + f(d), 0),
  cur: arr.slice(7).reduce((a, d) => a + f(d), 0),
});

async function loadAll() {
  overviewRequest?.abort();
  overviewRequest = new AbortController();
  seriesCache = null;
  reviewsLoaded = reposLoaded = settingsLoaded = false;
  try {
    const o = await api('/overview', { signal: overviewRequest.signal });
    document.getElementById('cFind').textContent = String(wholeNumber(o.findings.open));
    document.getElementById('cPulls').textContent = String(wholeNumber(o.pullRequests.open));
    document.getElementById('cRepos').textContent =
      (o.repos || []).filter((r) => r.enabled).length || '';
    await tiles(o);
    severity(o.findings);
  } catch (e) {
    if (e.name !== 'AbortError')
      document.getElementById('tiles').innerHTML =
        '<div class="empty">' + esc(e.error || 'Failed to load — try signing in again') + '</div>';
    return;
  }
  loadRecent();
  loadDeep();
  loadPulls();
  loadFindings();
}
async function tiles(o) {
  const s = o.stats,
    f = o.findings;
  const { days } = await series();
  const total = wholeNumber(f.open) + wholeNumber(f.fixed),
    rate = total ? Math.round((wholeNumber(f.fixed) / total) * 100) : 0;
  const avg = s.avgDurationMs ? dur(s.avgDurationMs) : '—';
  const by = f.bySeverity || {};
  const sev = [
    ['P1', wholeNumber(by.P1), 'var(--p1)'],
    ['P2', wholeNumber(by.P2), 'var(--p2)'],
    ['P3', wholeNumber(by.P3), 'var(--p3)'],
    ['Info', wholeNumber(by.info), 'var(--info)'],
  ];
  const sevTot = Math.max(
    1,
    sev.reduce((a, x) => a + x[1], 0),
  );
  const rv = half(days, (d) => d.reviews),
    bg = half(days, (d) => d.bugs);
  const t = (icon, label, val, body) =>
    '<div class="tile"><div class="tl">' +
    icon +
    esc(label) +
    '</div><div class="big">' +
    val +
    '</div>' +
    body +
    '</div>';
  const cap = (d, c) => '<div class="foot">' + d + '<span class="cap">' + c + '</span></div>';
  const tileList = [
    t(
      '<svg class="ti" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4v6h6"/><path d="M4 10a8 8 0 1 1 2.3 5.6"/></svg>',
      'Reviews · 14d',
      '<span class="num">' + wholeNumber(s.runsCompleted) + '</span>',
      '<div class="spark">' +
        spark(
          days.map((d) => d.reviews),
          'var(--accent)',
        ) +
        '</div>' +
        cap(deltaEl(rv.cur, rv.prev), 'vs prev 7d'),
    ),
    t(
      '<svg class="ti" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l9 16H3z"/><path d="M12 10v4"/><path d="M12 17h.01"/></svg>',
      'Bugs caught · 14d',
      '<span class="num">' + wholeNumber(s.findingsNew) + '</span>',
      '<div class="spark">' +
        spark(
          days.map((d) => d.bugs),
          'var(--good)',
        ) +
        '</div>' +
        cap(deltaEl(bg.cur, bg.prev), 'vs prev 7d'),
    ),
    t(
      '<svg class="ti" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l9 16H3z"/><path d="M12 10v4"/></svg>',
      'Open findings',
      '<span class="num">' + wholeNumber(f.open) + '</span>',
      '<div class="sevsplit">' +
        sev
          .map(
            (x) =>
              '<progress class="severity-part ' +
              x[0].toLowerCase() +
              '" max="' +
              sevTot +
              '" value="' +
              x[1] +
              '"></progress>',
          )
          .join('') +
        '</div><div class="sevkeys">' +
        sev
          .slice(0, 3)
          .map(
            (x) =>
              '<span><i class="severity-key ' +
              x[0].toLowerCase() +
              '"></i>' +
              x[0] +
              ' <b class="num">' +
              x[1] +
              '</b></span>',
          )
          .join('') +
        '</div>',
    ),
    t(
      '<svg class="ti" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
      'Avg review time',
      esc(avg),
      '<div class="spark">' +
        spark(
          days.map((d) => (d.durN ? d.durSum / d.durN / 1000 : 0)),
          'var(--p3)',
        ) +
        '</div>' +
        cap('<span class="delta flat">' + rate + '%</span>', 'fix rate'),
    ),
  ];
  if (SHOW_LLM_COST) {
    const ct = half(days, (d) => d.cost);
    tileList.push(
      t(
        '<svg class="ti" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v10M9.5 9.2A2.4 2 0 0 1 12 8c1.5 0 2.3.8 2.3 1.7s-.8 1.6-2.3 1.9-2.3 1-2.3 1.9.9 1.7 2.3 1.7a2.4 2 0 0 0 2.5-1.2"/></svg>',
        'Est. LLM cost · 14d',
        '<small>~$</small><span class="num">' + Number(s.costUsd || 0).toFixed(2) + '</span>',
        '<div class="spark">' +
          spark(
            days.map((d) => d.cost),
            'var(--p2)',
          ) +
          '</div>' +
          cap(
            deltaEl(Number(ct.cur.toFixed(2)), Number(ct.prev.toFixed(2)), '', true),
            'vs prev 7d',
          ),
      ),
    );
  }
  document.getElementById('tiles').innerHTML = tileList.join('');
}
function severity(f) {
  const by = f.bySeverity || {},
    max = Math.max(
      1,
      wholeNumber(by.P1),
      wholeNumber(by.P2),
      wholeNumber(by.P3),
      wholeNumber(by.info),
    );
  document.getElementById('sevSub').textContent = wholeNumber(f.open) + ' open across all repos';
  const rows = [
    ['P1 · Critical', 'p1', wholeNumber(by.P1)],
    ['P2 · High', 'p2', wholeNumber(by.P2)],
    ['P3 · Medium', 'p3', wholeNumber(by.P3)],
    ['Low · info', 'info', wholeNumber(by.info)],
  ];
  let html = rows
    .map(
      ([n, kind, v]) =>
        '<div class="sevbar-row"><span class="lbl"><i class="severity-key ' +
        kind +
        '"></i>' +
        n +
        '</span><progress class="severity-meter ' +
        kind +
        '" max="' +
        max +
        '" value="' +
        v +
        '"></progress><span class="cnt num severity-key ' +
        kind +
        '">' +
        v +
        '</span></div>',
    )
    .join('');
  if (wholeNumber(f.fixed) > 0)
    html +=
      '<div class="sev-foot"><span class="chk"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg></span><span><b>' +
      wholeNumber(f.fixed) +
      ' fixed</b> — Orvex committed the fix and closed them.</span></div>';
  document.getElementById('sevBody').innerHTML = html;
}
async function loadRecent(skipChart) {
  try {
    const { days, all } = await series();
    const b = document.getElementById('recentBody');
    const recent = all.slice().reverse().slice(0, 7);
    b.innerHTML = recent.length
      ? recent
          .map(
            (r) =>
              '<tr><td class="repo mono"><span class="org">' +
              esc((r.owner || '') + '/') +
              '</span>' +
              esc(r.repo || '') +
              '</td><td class="mono">#' +
              wholeNumber(r.pr) +
              '</td><td>' +
              trigCell(r) +
              '</td><td>' +
              runChip(r.status, runReason(r)) +
              '</td><td class="r num">' +
              wholeNumber(r.findingsNew) +
              '</td><td class="r mono">' +
              (r.status === 'running' ? '…' : dur(r.durationMs)) +
              '</td><td class="r mono">' +
              rel(r.createdAt) +
              '</td></tr>',
          )
          .join('')
      : '<tr><td colspan="7" class="empty">No reviews yet.</td></tr>';
    if (!skipChart) drawChart(days);
  } catch {
    if (!skipChart) drawChart([]);
  }
}
function trigCell(r) {
  // Map the raw webhook/job action to a clear "what triggered this" label so runs
  // are distinguishable: manual (@orvex review) vs auto-on-PR-open vs auto-on-commit.
  const M = {
    opened: ['Auto · PR opened', 'auto'],
    reopened: ['Auto · PR reopened', 'auto'],
    synchronize: ['Auto · new commit', 'commit'],
    command: ['Manual', 'manual'],
    manual: ['Manual (API)', 'manual'],
  };
  const e = M[r.action] || [r.action || 'review', 'auto'];
  const label = r.deep ? e[0] + ' · deep' : e[0];
  return (
    '<span class="trig ' +
    e[1] +
    (r.deep ? ' deep' : '') +
    '" title="' +
    esc((r.action || '') + (r.deep ? ' (deep pass)' : '')) +
    '"><span class="tdot"></span>' +
    esc(label) +
    '</span>'
  );
}
async function loadDeep() {
  try {
    const { days, all } = await series();
    const done = all.filter((r) => r.status === 'completed');
    const deep = done.filter((r) => r.deep),
      norm = done.filter((r) => !r.deep);
    if (!SHOW_LLM_COST) {
      document.getElementById('deepBody').innerHTML =
        '<div class="dvn-grid"><div class="dvn-card"><div class="k"><i></i>Normal</div><div class="runs num">' +
        norm.length +
        ' <small>runs</small></div></div><div class="dvn-card deep"><div class="k"><i></i>Deep</div><div class="runs num">' +
        deep.length +
        ' <small>runs</small></div></div></div>';
      return;
    }
    const avg = (a) => (a.length ? a.reduce((s, r) => s + (r.costUsd || 0), 0) / a.length : 0);
    const na = avg(norm),
      da = avg(deep);
    const deepBugs = deep.length
      ? deep.reduce((s, r) => s + (r.findingsNew || 0), 0) / deep.length
      : 0;
    const normBugs = norm.length
      ? norm.reduce((s, r) => s + (r.findingsNew || 0), 0) / norm.length
      : 0;
    let html =
      '<div class="dvn-grid"><div class="dvn-card"><div class="k"><i></i>Normal</div><div class="runs num">' +
      norm.length +
      ' <small>runs</small></div><div class="avg">avg <b>' +
      usd(na) +
      '</b> / review</div></div>' +
      '<div class="dvn-card deep"><div class="k"><i></i>Deep</div><div class="runs num">' +
      deep.length +
      ' <small>runs</small></div><div class="avg">avg <b>' +
      usd(da) +
      '</b> / review</div></div></div>';
    if (deep.length && norm.length) {
      const more = deepBugs - normBugs;
      html +=
        '<div class="sev-foot deep-note"><span class="chk"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l9 16H3z" opacity="0"/><path d="M5 12h14"/></svg></span><span>Deep surfaced <b>' +
        (more > 0 ? '+' + more.toFixed(1) : more.toFixed(1)) +
        ' findings/PR</b> more than normal, for ~' +
        usd(da - na) +
        ' extra.</span></div>';
    } else if (!deep.length)
      html +=
        '<div class="empty spaced-empty">No deep runs yet. Comment <code>@orvex deep</code> on a PR to run extra passes.</div>';
    document.getElementById('deepBody').innerHTML = html;
  } catch (e) {
    document.getElementById('deepBody').innerHTML =
      '<div class="empty">' + esc(e.error || 'error') + '</div>';
  }
}
// Keep status current without replacing the control or row a keyboard user is using.
function activeElementIsInside(selector) {
  const container = document.querySelector(selector);
  return Boolean(container && document.activeElement && container.contains(document.activeElement));
}
setInterval(() => {
  if (document.visibilityState !== 'visible') return;
  if (document.getElementById('v-overview').classList.contains('active')) {
    if (activeElementIsInside('#recentBody')) return;
    seriesCache = null;
    loadRecent(true);
  } else if (document.getElementById('v-reviews').classList.contains('active')) {
    if (activeElementIsInside('#reviewsBody')) return;
    reviewsLoaded = false;
    loadReviews();
  }
}, 6000);

function drawChart(days) {
  const ns = 'http://www.w3.org/2000/svg',
    W = 640,
    H = 210,
    pL = 30,
    pR = 10,
    pT = 12,
    pB = 26,
    pw = W - pL - pR,
    ph = H - pT - pB;
  const el = (t, a) => {
    const e = document.createElementNS(ns, t);
    for (const k in a) e.setAttribute(k, a[k]);
    return e;
  };
  ['gGrid', 'gBars', 'gX', 'gY'].forEach((id) => (document.getElementById(id).innerHTML = ''));
  const description = document.getElementById('chartDescription');
  if (!days.length) {
    description.textContent = 'No completed reviews in the last 14 days.';
    return;
  }
  const data = days.map((d) => ({ label: d.label, v: d.reviews }));
  description.textContent =
    'Reviews per day: ' + data.map((point) => point.label + ' ' + point.v).join(', ') + '.';
  const max = Math.max(4, ...data.map((d) => d.v)),
    n = data.length,
    slot = pw / n,
    bw = Math.min(26, slot * 0.62);
  const y = (v) => pT + ph - (v / max) * ph;
  const g = document.getElementById('gGrid'),
    bars = document.getElementById('gBars'),
    gx = document.getElementById('gX'),
    gy = document.getElementById('gY'),
    tip = document.getElementById('tip'),
    svg = document.querySelector('#chart svg');
  [0, Math.round(max / 2), max].forEach((tk) => {
    g.appendChild(
      el('line', {
        x1: pL,
        x2: W - pR,
        y1: y(tk),
        y2: y(tk),
        stroke: 'var(--grid)',
        'stroke-width': 1,
      }),
    );
    const lb = el('text', {
      x: pL - 7,
      y: y(tk) + 3,
      'text-anchor': 'end',
      'font-size': 10,
      fill: 'var(--ink-3)',
      'font-family': 'var(--mono)',
    });
    lb.textContent = tk;
    gy.appendChild(lb);
  });
  data.forEach((pt, i) => {
    const cx = pL + slot * i + slot / 2,
      bh = (pt.v / max) * ph,
      grp = el('g', { class: 'bar-group' });
    grp.appendChild(
      el('rect', {
        class: 'bar-rect',
        x: cx - bw / 2,
        y: y(pt.v),
        width: bw,
        height: Math.max(bh, 1),
        fill: 'var(--accent)',
        rx: 3,
      }),
    );
    grp.appendChild(
      el('rect', { x: pL + slot * i, y: pT, width: slot, height: ph, fill: 'transparent' }),
    );
    grp.addEventListener('mousemove', () => {
      const box = svg.getBoundingClientRect();
      tip.textContent = pt.label + ' · ' + pt.v;
      tip.style.left = (cx * box.width) / W + 'px';
      tip.style.top = (y(pt.v) * box.height) / H + 'px';
      tip.style.opacity = '1';
    });
    grp.addEventListener('mouseleave', () => (tip.style.opacity = '0'));
    bars.appendChild(grp);
    if (i % 2 === 1) {
      const xl = el('text', {
        x: cx,
        y: H - 8,
        'text-anchor': 'middle',
        'font-size': 10,
        fill: 'var(--ink-3)',
      });
      xl.textContent = pt.label;
      gx.appendChild(xl);
    }
  });
}
async function loadPulls() {
  try {
    const { pulls, counts } = await api('/pulls?limit=100');
    document.getElementById('pullSub').textContent =
      wholeNumber(counts.open) +
      ' open · ' +
      wholeNumber(counts.merged) +
      ' merged · ' +
      wholeNumber(counts.closed) +
      ' closed';
    const b = document.getElementById('pullBody');
    b.innerHTML = pulls.length
      ? pulls
          .map(
            (p) =>
              '<tr><td class="mono">' +
              esc(repoShort(p.repoFullName).pop()) +
              '</td><td><span class="pr-t mono">#' +
              wholeNumber(p.number) +
              ' ' +
              esc(p.title || '') +
              '</span></td><td><span class="chip ' +
              (p.state === 'merged' ? 'p3' : p.state === 'closed' ? 'muted' : 'ok') +
              '"><span class="cd"></span>' +
              esc(p.state) +
              '</span></td><td class="r">' +
              (wholeNumber(p.openFindings) > 0
                ? '<span class="chip p2">' + wholeNumber(p.openFindings) + '</span>'
                : '<span class="chip ok">0</span>') +
              '</td><td class="r mono">' +
              rel(p.lastReviewedAt) +
              '</td></tr>',
          )
          .join('')
      : '<tr><td colspan="5" class="empty">No pull requests recorded yet.</td></tr>';
  } catch (e) {
    document.getElementById('pullBody').innerHTML =
      '<tr><td colspan="5" class="empty">' + esc(e.error || 'error') + '</td></tr>';
  }
}
async function loadFindings() {
  try {
    const { findings } = await api('/findings?limit=100');
    const b = document.getElementById('findBody');
    b.innerHTML = findings.length
      ? findings
          .map(
            (f) =>
              '<tr><td><span class="chip ' +
              sevCls(f.severity) +
              '">' +
              esc(f.severity) +
              '</span></td><td class="mono">' +
              esc(repoShort(f.repoFullName).pop()) +
              ' #' +
              wholeNumber(f.prNumber) +
              '</td><td class="mono">' +
              esc(repoShort(f.file).pop()) +
              (wholeNumber(f.line) > 0 ? ':' + wholeNumber(f.line) : '') +
              '</td><td><span class="pr-t">' +
              esc((f.message || '').slice(0, 90)) +
              '</span></td><td><span class="chip ' +
              (f.status === 'fixed' ? 'ok' : f.status === 'ignored' ? 'muted' : 'p2') +
              '">' +
              esc(f.status) +
              (f.status === 'fixed' && f.fixedAtSha
                ? ' ' + esc(String(f.fixedAtSha).slice(0, 7))
                : '') +
              '</span></td></tr>',
          )
          .join('')
      : '<tr><td colspan="5" class="empty">No findings yet.</td></tr>';
  } catch (e) {
    document.getElementById('findBody').innerHTML =
      '<tr><td colspan="5" class="empty">' + esc(e.error || 'error') + '</td></tr>';
  }
}
let reviewsLoaded = false;
async function loadReviews() {
  if (reviewsLoaded) return;
  reviewsLoaded = true;
  try {
    const { reviews } = await api('/reviews?limit=100');
    const b = document.getElementById('reviewsBody');
    const cols = SHOW_LLM_COST ? 7 : 6;
    b.innerHTML = reviews.length
      ? reviews
          .slice()
          .reverse()
          .map(
            (r) =>
              '<tr><td class="repo mono"><span class="org">' +
              esc((r.owner || '') + '/') +
              '</span>' +
              esc(r.repo || '') +
              '</td><td class="mono">#' +
              wholeNumber(r.pr) +
              '</td><td>' +
              trigCell(r) +
              '</td><td>' +
              runChip(r.status, runReason(r)) +
              '</td>' +
              (SHOW_LLM_COST
                ? '<td class="r mono" title="' +
                  (r.costEstimated
                    ? 'Estimated because one or more provider attempts did not report usage. A timed-out call may have incurred additional spend.'
                    : 'Reported provider usage, including cache reads when supplied.') +
                  '">' +
                  estimatedUsd(r.costUsd, r.costEstimated) +
                  '</td>'
                : '') +
              '<td class="r mono">' +
              (r.status === 'running' ? '…' : dur(r.durationMs)) +
              '</td><td class="r mono">' +
              rel(r.createdAt) +
              '</td></tr>',
          )
          .join('')
      : '<tr><td colspan="' + cols + '" class="empty">No review runs yet.</td></tr>';
  } catch (e) {
    document.getElementById('reviewsBody').innerHTML =
      '<tr><td colspan="' +
      (SHOW_LLM_COST ? 7 : 6) +
      '" class="empty">' +
      esc(e.error || 'error') +
      '</td></tr>';
  }
}
let reposLoaded = false;
document.getElementById('syncRepos').addEventListener('click', async () => {
  const b = document.getElementById('syncRepos');
  b.disabled = true;
  b.textContent = 'Syncing…';
  try {
    const r = await fetch('/api/workspaces/' + encodeURIComponent(SLUG) + '/repos/sync', {
      method: 'POST',
      credentials: 'same-origin',
    });
    if (!r.ok) throw await r.json().catch(() => ({ error: 'sync failed' }));
    reposLoaded = false;
    await loadRepos();
    b.textContent = 'Synced';
  } catch (e) {
    b.textContent = e.error || 'Sync failed';
  } finally {
    setTimeout(() => {
      b.disabled = false;
      b.textContent = 'Sync from GitHub';
    }, 1800);
  }
});
async function loadRepos() {
  if (reposLoaded) return;
  reposLoaded = true;
  const list = document.getElementById('reposList');
  try {
    const { repos } = await api('/repos');
    list.innerHTML = repos.length
      ? repos
          .map(
            (r) =>
              '<div class="repo-row"><span class="rn">' +
              esc(r.fullName) +
              '</span><span class="rm"><span class="muted compact-muted">' +
              (r.private ? 'private' : 'public') +
              '</span><button class="toggle" type="button" role="switch" aria-label="Enable reviews for ' +
              esc(r.fullName) +
              '" aria-checked="' +
              Boolean(r.enabled) +
              '" data-id="' +
              wholeNumber(r.id) +
              '"></button></span></div>',
          )
          .join('')
      : '<div class="empty">No repositories. Click “Add repositories”.</div>';
    list
      .querySelectorAll('.toggle')
      .forEach((t) => t.addEventListener('click', () => toggleRepo(t)));
  } catch (e) {
    list.innerHTML = '<div class="empty">' + esc(e.error || 'error') + '</div>';
  }
}
async function toggleRepo(t) {
  const next = t.getAttribute('aria-checked') !== 'true';
  t.setAttribute('aria-checked', next);
  try {
    await fetch('/api/workspaces/' + encodeURIComponent(SLUG) + '/repos/' + t.dataset.id, {
      method: 'PATCH',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: next }),
    }).then((r) => {
      if (!r.ok) throw 0;
    });
  } catch {
    t.setAttribute('aria-checked', !next);
  }
}
let settingsLoaded = false;
async function loadSettings() {
  if (settingsLoaded) return;
  settingsLoaded = true;
  const list = document.getElementById('settingsList');
  try {
    const { repos } = await api('/repos');
    list.innerHTML = repos.length
      ? repos
          .map(
            (r) =>
              '<div class="settings-row"><div class="sr-head"><span class="rn">' +
              esc(r.fullName) +
              '</span>' +
              (r.enabled ? '' : '<span class="chip muted">repo disabled</span>') +
              '</div><div class="sr-toggles">' +
              '<div class="sr-toggle"><button class="toggle" type="button" role="switch" aria-label="Run on each pull request for ' +
              esc(r.fullName) +
              '" aria-checked="' +
              Boolean(r.reviewOnOpen) +
              '" data-id="' +
              wholeNumber(r.id) +
              '" data-field="reviewOnOpen"></button><span><strong>Run on each PR</strong><br><span class="muted compact-muted">Auto-review when a pull request is opened (or reopened)</span></span></div>' +
              '<div class="sr-toggle"><button class="toggle" type="button" role="switch" aria-label="Run on each commit for ' +
              esc(r.fullName) +
              '" aria-checked="' +
              Boolean(r.reviewOnPush) +
              '" data-id="' +
              wholeNumber(r.id) +
              '" data-field="reviewOnPush"></button><span><strong>Run on each commit</strong><br><span class="muted compact-muted">Auto-review again on every new push to an open PR</span></span></div>' +
              '</div></div>',
          )
          .join('')
      : '<div class="empty">No repositories. Click “Add repositories”.</div>';
    list
      .querySelectorAll('.toggle')
      .forEach((t) => t.addEventListener('click', () => toggleSetting(t)));
  } catch (e) {
    list.innerHTML = '<div class="empty">' + esc(e.error || 'error') + '</div>';
  }
}
async function toggleSetting(t) {
  const next = t.getAttribute('aria-checked') !== 'true';
  t.setAttribute('aria-checked', next);
  try {
    await fetch('/api/workspaces/' + encodeURIComponent(SLUG) + '/repos/' + t.dataset.id, {
      method: 'PATCH',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ [t.dataset.field]: next }),
    }).then((r) => {
      if (!r.ok) throw 0;
    });
  } catch {
    t.setAttribute('aria-checked', !next);
  }
}
let installsLoaded = false;
async function loadInstalls() {
  if (installsLoaded) return;
  installsLoaded = true;
  try {
    const { installations } = await api('/installations');
    const el = document.getElementById('installs');
    el.innerHTML = installations.length
      ? installations
          .map(
            (i) =>
              '<div class="install-row"><span class="ws-ava install-avatar">' +
              esc((i.account || '?').slice(0, 2).toUpperCase()) +
              '</span><div><div class="org">' +
              esc(i.account) +
              ' <span class="chip ' +
              (i.suspended ? 'p2' : 'ok') +
              ' chip-offset"><span class="cd"></span>' +
              (i.suspended ? 'Suspended' : 'Active') +
              '</span></div><div class="meta">' +
              esc(i.accountType) +
              ' · ' +
              esc(i.repositorySelection) +
              ' · #' +
              wholeNumber(i.installationId) +
              '</div></div><div class="right"><a class="ghost install-link" href="/connect">Configure</a></div></div>',
          )
          .join('')
      : '<div class="empty">No installations.</div>';
  } catch (e) {
    document.getElementById('installs').innerHTML =
      '<div class="empty">' + esc(e.error || 'error') + '</div>';
  }
}
loadAll();
