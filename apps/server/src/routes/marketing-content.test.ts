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
    compareResponse,
    compareMdResponse,
    llmsResponse,
    llmsFullResponse,
    indexMdResponse,
    robotsResponse,
    sitemapResponse,
  ] = await Promise.all([
    app.request('/'),
    app.request('/pricing'),
    app.request('/privacy'),
    app.request('/terms'),
    app.request('/refunds'),
    app.request('/compare'),
    app.request('/compare.md'),
    app.request('/llms.txt'),
    app.request('/llms-full.txt'),
    app.request('/index.md'),
    app.request('/robots.txt'),
    app.request('/sitemap.xml'),
  ]);
  assert.equal(homeResponse.status, 200);
  assert.equal(pricingResponse.status, 301);
  assert.equal(pricingResponse.headers.get('location'), '/#pricing');
  assert.equal(privacyResponse.status, 200);
  assert.equal(termsResponse.status, 200);
  assert.equal(refundsResponse.status, 200);
  assert.equal(compareResponse.status, 200);
  assert.equal(compareMdResponse.status, 200);
  assert.equal(llmsResponse.status, 200);
  assert.equal(llmsFullResponse.status, 200);
  assert.equal(indexMdResponse.status, 200);
  assert.equal(robotsResponse.status, 200);
  assert.equal(robotsResponse.headers.get('cache-control'), 'no-cache');
  assert.equal(sitemapResponse.status, 200);
  assert.match(homeResponse.headers.get('link') ?? '', /rel="describedby"/);
  assert.match(indexMdResponse.headers.get('content-type') ?? '', /text\/markdown/);

  const home = await homeResponse.text();
  const privacy = await privacyResponse.text();
  const terms = await termsResponse.text();
  const refunds = await refundsResponse.text();
  const compare = await compareResponse.text();
  const compareMd = await compareMdResponse.text();
  const llms = await llmsResponse.text();
  const llmsFull = await llmsFullResponse.text();
  const indexMd = await indexMdResponse.text();
  const robots = await robotsResponse.text();
  const sitemap = await sitemapResponse.text();
  const normalizedHome = home.replace(/\s+/g, ' ');
  const normalizedPrivacy = privacy.replace(/\s+/g, ' ');
  const normalizedTerms = terms.replace(/\s+/g, ' ');
  const normalizedRefunds = refunds.replace(/\s+/g, ' ');
  const publicContent = `${home}\n${privacy}\n${terms}\n${refunds}\n${compare}\n${compareMd}\n${llms}\n${llmsFull}\n${indexMd}`;
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
  assert.match(home, /viewport-fit=cover/);
  assert.match(compare, /class="table-scroll"/);
  assert.match(home, /rel="describedby" href="https:\/\/useorvex.com\/llms.txt"/);
  assert.match(home, /AI code review for GitHub pull requests/);
  assert.match(home, /id="install"/);
  assert.match(home, /id="faq"/);
  assert.equal((home.match(/class="faq-item"/g) ?? []).length, 18);
  assert.match(home, /What is the best AI code review tool for GitHub pull requests/);
  assert.match(home, /Is Orvex a CodeRabbit alternative/);
  assert.match(home, /href="\/compare"/);
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
  assert.match(llms, /^# Orvex\n/m);
  assert.match(llms, /https:\/\/useorvex.com\/index.md/);
  assert.match(
    llmsFull,
    /Every plan receives deterministic checks, source verification, and autofix/,
  );
  assert.match(
    llmsFull,
    /Plans otherwise differ by review track, pass count, allowance, hourly capacity/,
  );
  assert.doesNotMatch(llmsFull, /same three-pass depth/i);
  assert.match(indexMd, /Orvex is a GitHub App that reviews pull requests when they open/);
  assert.match(sitemap, /<lastmod>2026-08-15<\/lastmod>/);
  assert.match(sitemap, /https:\/\/useorvex.com\/compare</);
  assert.match(sitemap, /https:\/\/useorvex.com\/llms.txt</);
  assert.match(sitemap, /https:\/\/useorvex.com\/index.md</);
  assert.match(compare, /does not claim feature parity/i);
  assert.match(compareMd, /does not claim feature parity/i);
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
  const parsed = JSON.parse(structuredData) as { '@graph'?: Array<{ '@type'?: string }> };
  assert.ok(Array.isArray(parsed['@graph']));
  assert.ok(parsed['@graph']?.some((node) => node['@type'] === 'HowTo'));
  assert.ok(parsed['@graph']?.some((node) => node['@type'] === 'FAQPage'));
  assert.ok(parsed['@graph']?.some((node) => node['@type'] === 'WebPage'));
  const faqNode = parsed['@graph']?.find((node) => node['@type'] === 'FAQPage') as
    | { mainEntity?: unknown[] }
    | undefined;
  assert.ok((faqNode?.mainEntity?.length ?? 0) >= 16);
  for (const page of [home, privacy, terms, refunds, compare]) {
    assert.doesNotMatch(page, /<style|style=/);
  }
  assert.match(home, /href="\/assets\/marketing\.css"/);
  assert.match(home, /src="\/assets\/marketing\.js" defer/);
  for (const page of [privacy, terms, refunds, compare]) {
    assert.match(page, /href="\/assets\/legal\.css"/);
  }
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
