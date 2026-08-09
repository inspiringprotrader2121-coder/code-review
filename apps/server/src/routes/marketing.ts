import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { formatCommandsHtmlRows } from '@orvex-review/review';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The social-share card referenced by the marketing page's og:image / twitter:image
// (https://useorvex.com/og-image.png). Read once; served as a real PNG so link
// previews on Slack/X/iMessage render. Missing file → 404 rather than a crash.
let ogImageCache: ArrayBuffer | null | undefined;
function ogImage(): ArrayBuffer | null {
  if (ogImageCache === undefined) {
    try {
      const buf = readFileSync(path.resolve(__dirname, '../../og-image.png'));
      // Copy into a standalone ArrayBuffer — Buffer.buffer may be a shared pool
      // slice, and Hono's c.body() wants an ArrayBuffer, not a Node Buffer.
      ogImageCache = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    } catch {
      ogImageCache = null;
    }
  }
  return ogImageCache;
}

// The Fable-designed landing page + legal pages. Loaded once each; served at
// the app root so the marketing site and the app live on ONE domain.
const pageCache = new Map<string, string>();
function staticPage(file: string, fallbackTitle: string): string {
  let html = pageCache.get(file);
  if (html === undefined) {
    try {
      html = readFileSync(path.resolve(__dirname, `../../${file}`), 'utf8');
    } catch {
      html = `<!doctype html><title>${fallbackTitle}</title><h1>${fallbackTitle}</h1><p><a href="/">useorvex.com</a></p>`;
    }
    pageCache.set(file, html);
  }
  return html;
}

export function marketingRoutes() {
  const app = new Hono();
  app.get('/', (c) => {
    // Inject the live command catalog so marketing never drifts from the parser.
    const html = staticPage('marketing.html', 'Orvex Review').replace(
      '<!--ORVEX_COMMANDS_ROWS-->',
      formatCommandsHtmlRows('@orvex'),
    );
    return c.html(html);
  });
  // Keep older upgrade links working while the pricing section remains an
  // anchor on the single-page marketing site.
  app.get('/pricing', (c) => c.redirect('/#pricing', 301));
  // Social-share card for og:image / twitter:image on the marketing page.
  app.get('/og-image.png', (c) => {
    const png = ogImage();
    if (!png) return c.notFound();
    c.header('Content-Type', 'image/png');
    c.header('Cache-Control', 'public, max-age=86400');
    return c.body(png);
  });
  // Legal pages — linked from the pricing section, the footer, and Stripe.
  app.get('/terms', (c) => c.html(staticPage('terms.html', 'Terms of Service')));
  app.get('/privacy', (c) => c.html(staticPage('privacy.html', 'Privacy Policy')));
  app.get('/refunds', (c) => c.html(staticPage('refunds.html', 'Refund Policy')));

  // ——— SEO / AI-discoverability ———
  // robots.txt: all crawlers may index public content, but authenticated and
  // operational routes stay excluded. A single wildcard group matters here:
  // named bot groups with `Allow: /` would override these private-route rules.
  app.get('/robots.txt', (c) => {
    c.header('Content-Type', 'text/plain; charset=utf-8');
    // Crawler policy is security-sensitive and has changed during launch. Force
    // shared caches to revalidate so an obsolete bot-specific Allow rule cannot
    // remain at the edge for a full day after a deploy.
    c.header('Cache-Control', 'no-cache');
    return c.body(
      [
        'User-agent: *',
        'Allow: /',
        'Disallow: /dashboard',
        'Disallow: /auth',
        'Disallow: /api',
        'Disallow: /superadmin',
        'Disallow: /connect',
        'Disallow: /settings',
        'Disallow: /buy',
        'Disallow: /webhooks',
        '',
        'Sitemap: https://useorvex.com/sitemap.xml',
        '',
      ].join('\n'),
    );
  });

  app.get('/sitemap.xml', (c) => {
    const pages = ['/', '/terms', '/privacy', '/refunds'];
    const urls = pages
      .map(
        (p) =>
          `  <url><loc>https://useorvex.com${p}</loc><changefreq>${p === '/' ? 'weekly' : 'monthly'}</changefreq><priority>${p === '/' ? '1.0' : '0.5'}</priority></url>`,
      )
      .join('\n');
    c.header('Content-Type', 'application/xml; charset=utf-8');
    c.header('Cache-Control', 'public, max-age=86400');
    return c.body(
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
    );
  });

  // llms.txt: a concise, factual, machine-readable brief for LLM ingestion
  // (an emerging convention for generative-engine optimization). Plain facts,
  // no marketing fluff, so an answer engine can quote it accurately.
  app.get('/llms.txt', (c) => {
    c.header('Content-Type', 'text/plain; charset=utf-8');
    c.header('Cache-Control', 'public, max-age=86400');
    return c.body(LLMS_TXT);
  });

  return app;
}

const LLMS_TXT = `# Orvex

> Orvex is an AI code reviewer for GitHub pull requests. It uses a layered pipeline
> of deterministic checks, focused AI analysis, and strict finding verification
> to catch bugs before production.

## What it does
- Reviews enabled GitHub repositories automatically on pull-request open and new pushes by default; each trigger can be changed per repository. \`@orvex review\` starts an on-demand review.
- Runs deterministic rules first, then two or four focused AI review passes depending on the review track, then a strict verifier that re-checks candidate findings against source context before posting.
- Reads the changed files plus selected imports, dependents, and relevant repository files. It reports when GitHub or configured file limits make coverage partial.
- Tracks findings across pushes, suppresses already-reported issues, and marks findings fixed when their source anchor changes.
- One-command auto-fix (\`@orvex fix\` / \`@orvex fix all\`) that re-verifies each finding before writing a fix.
- Gives a copy-paste prompt per finding for use with a coding agent.
- Paid plans can request additional analysis with \`@orvex deep\`; a deep review uses two review units.
- Comment \`@orvex help\` on any PR for the full command list, or \`@orvex rate limit\` to check remaining quota without starting a review.
- Repositories can tune ignores, comment limits, and deterministic checks with \`.orvex-review.yml\`. Finding confidence is recorded as telemetry, not a suppression threshold.

## Pricing (USD)
- Free: 10 lifetime reviews at up to 2/hour, no card required.
- Starter: $29/month — 100 reviews included at up to 5/hour, then prepaid overage at $0.50/review.
- Pro: $69/month — 500 reviews/month at up to 10/hour.
- Verify Lite: $49/month — 50 reviews included at up to 5/hour, then prepaid overage at $0.75/review on the advanced review track.
- Verify: $99/month — 120 reviews included at up to 10/hour, then prepaid overage at $1.50/review on the advanced review track.
A completed standard review uses one unit. An \`@orvex deep\` review uses two.
Skipped reviews and fix or explanation commands do not consume units. Failed reviews still count toward free-trial, hourly, and monthly caps.
Overage past the included monthly total requires prepaid wallet credits bought in the dashboard — reviews stop if the wallet is empty.
Every plan receives deterministic checks, source verification, and autofix. Paid plans add on-demand deep review. Plans otherwise differ by review track, pass count, allowance, hourly capacity, queue priority, and support.

## Billing
- Pricing is per workspace, not per developer seat.
- Only a workspace owner can purchase or change a plan.
- For cancellation or billing help, contact support@useorvex.com from the account email.

## Links
- Home: https://useorvex.com/
- Pricing: https://useorvex.com/#pricing
- Contact: support@useorvex.com
`;
