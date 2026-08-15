import assert from 'node:assert/strict';
import test from 'node:test';
import { marketingRoutes } from './marketing.js';

test('public marketing explains every plan and does not disclose review providers or model counts', async () => {
  const app = marketingRoutes();
  const [
    homeResponse,
    pricingResponse,
    privacyResponse,
    termsResponse,
    refundsResponse,
    llmsResponse,
    robotsResponse,
  ] = await Promise.all([
    app.request('/'),
    app.request('/pricing'),
    app.request('/privacy'),
    app.request('/terms'),
    app.request('/refunds'),
    app.request('/llms.txt'),
    app.request('/robots.txt'),
  ]);
  assert.equal(homeResponse.status, 200);
  assert.equal(pricingResponse.status, 301);
  assert.equal(pricingResponse.headers.get('location'), '/#pricing');
  assert.equal(privacyResponse.status, 200);
  assert.equal(termsResponse.status, 200);
  assert.equal(refundsResponse.status, 200);
  assert.equal(llmsResponse.status, 200);
  assert.equal(robotsResponse.status, 200);
  assert.equal(robotsResponse.headers.get('cache-control'), 'no-cache');

  const home = await homeResponse.text();
  const privacy = await privacyResponse.text();
  const terms = await termsResponse.text();
  const refunds = await refundsResponse.text();
  const llms = await llmsResponse.text();
  const robots = await robotsResponse.text();
  const normalizedHome = home.replace(/\s+/g, ' ');
  const normalizedPrivacy = privacy.replace(/\s+/g, ' ');
  const normalizedTerms = terms.replace(/\s+/g, ' ');
  const normalizedRefunds = refunds.replace(/\s+/g, ' ');
  const publicContent = `${home}\n${privacy}\n${terms}\n${refunds}\n${llms}`;
  assert.doesNotMatch(
    publicContent,
    /multi[- ]model|[23]\s+AI models?|model·[ABC]|\b(?:MiniMax|DeepSeek|GLM|Luna|Anthropic)\b|bring-your-own-LLM/i,
  );
  assert.doesNotMatch(
    publicContent,
    /sandbox execution|runs your code|runtime evidence|131 (?:issues|bugs)|43%|widest coverage|other bots missed|benchmarked on 80/i,
  );
  assert.doesNotMatch(publicContent, /enterprise/i);

  for (const expected of [
    '10 lifetime reviews · 2/hour',
    '100/month · 5/hour',
    '500/month · 10/hour',
    '50/month · 5/hour',
    '120/month · 10/hour',
    'Hard monthly total',
    'Then prepaid overage',
    'An <span class="mono">@orvex deep</span> review uses two units',
    'Only a workspace owner can start or change billing',
  ]) {
    assert.match(normalizedHome, new RegExp(escapeRegExp(expected)));
  }
  assert.match(home, /<meta name="yandex-verification" content="94885c8f0fa2d0a4" \/>/);
  assert.match(home, /id="faq"/);
  assert.equal((home.match(/class="faq-item"/g) ?? []).length, 11);
  assert.match(home, /id="commands"/);
  assert.match(home, /@orvex rate limit/);
  assert.match(home, /@orvex ignore &lt;file&gt;:&lt;line&gt;/);
  assert.match(home, /What commands can I run on a pull request/);
  assert.match(
    normalizedHome,
    /Every plan includes deterministic checks, two or four focused review passes by track, strict verification, finding memory, and autofix/,
  );
  assert.match(normalizedHome, /Paid plans also include on-demand deep review/);
  assert.doesNotMatch(home, /Every plan keeps the same review depth/i);
  assert.doesNotMatch(home, /Every plan gets three focused review passes/i);
  for (const legalPath of ['/terms', '/privacy', '/refunds']) {
    assert.match(home, new RegExp(`href="${escapeRegExp(legalPath)}"`));
  }
  assert.match(llms, /Every plan receives deterministic checks, source verification, and autofix/);
  assert.match(
    llms,
    /Plans otherwise differ by review track, pass count, allowance, hourly capacity/,
  );
  assert.doesNotMatch(llms, /same three-pass depth/i);
  assert.match(normalizedPrivacy, /contracted third-party AI inference providers/);
  assert.match(normalizedPrivacy, /temporary filesystem snapshot/);
  assert.match(
    normalizedPrivacy,
    /standard API review requests contain the diff and selected excerpts/i,
  );
  assert.match(normalizedTerms, /support@useorvex\.com/);
  assert.match(normalizedRefunds, /support@useorvex\.com/);
  assert.doesNotMatch(`${terms}\n${refunds}`, /cancel at any time from the dashboard/i);

  assert.equal((robots.match(/^User-agent:/gm) ?? []).length, 1);
  for (const privateRoute of [
    '/dashboard',
    '/auth',
    '/api',
    '/superadmin',
    '/connect',
    '/settings',
    '/buy',
    '/webhooks',
  ]) {
    assert.match(robots, new RegExp(`Disallow: ${escapeRegExp(privateRoute)}`));
  }

  const structuredData = home.match(
    /<script type="application\/ld\+json">([\s\S]*?)<\/script>/,
  )?.[1];
  assert.ok(structuredData, 'marketing page includes JSON-LD');
  const parsed = JSON.parse(structuredData) as { '@graph'?: unknown[] };
  assert.ok(Array.isArray(parsed['@graph']));
  for (const page of [home, privacy, terms, refunds]) {
    assert.doesNotMatch(page, /<style|style=/);
  }
  assert.match(home, /href="\/assets\/marketing\.css"/);
  assert.match(home, /src="\/assets\/marketing\.js" defer/);
  for (const page of [privacy, terms, refunds]) {
    assert.match(page, /href="\/assets\/legal\.css"/);
  }
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
