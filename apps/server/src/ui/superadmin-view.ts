/** Static operator shell. Dynamic data is loaded by the external super-admin module. */
export function renderSuperadminPage(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Orvex · Super Admin</title>
<link rel="stylesheet" href="/assets/superadmin.css"></head><body><main>
<div class="hero">
  <div><div class="eyebrow">Operator console / financial control</div><h1>Super Admin · Operations & Profitability</h1><p class="subtitle">Know what every review costs, who is profitable, and where spend is escaping.</p></div>
  <div class="toolbar"><select id="range" aria-label="Analytics range"><option value="1">Last 24 hours</option><option value="7">Last 7 days</option><option value="30" selected>Last 30 days</option><option value="90">Last 90 days</option></select><button id="refresh" class="secondary">Refresh data</button><button id="syncRevenue" class="secondary">Sync Stripe revenue</button><button id="rebuild" class="secondary">Rebuild scoreboard</button><button id="security" class="secondary">Account security</button><span id="status" role="status" aria-live="polite"></span></div>
</div>
<div id="live"></div>
<section id="deadLetters" aria-labelledby="deadLettersTitle" aria-live="polite"></section>
<section id="publicationClaims" aria-labelledby="publicationClaimsTitle" aria-live="polite"></section>
<div id="costs"></div>
<div id="deep"></div>
<div id="content"></div>
<script src="/assets/superadmin.js" defer></script>
</main></body></html>`;
}
