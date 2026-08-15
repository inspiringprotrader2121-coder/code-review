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

function staticPlain(file: string): string {
  let text = pageCache.get(file);
  if (text === undefined) {
    text = readFileSync(path.resolve(__dirname, `../../${file}`), 'utf8');
    pageCache.set(file, text);
  }
  return text;
}

function sendMarkdown(
  c: { header: (k: string, v: string) => void; body: (v: string) => Response },
  body: string,
) {
  c.header('Content-Type', 'text/markdown; charset=utf-8');
  c.header('Cache-Control', 'public, max-age=86400');
  c.header('Link', '</llms.txt>; rel="describedby"');
  return c.body(body.endsWith('\n') ? body : `${body}\n`);
}

function sendHtml(
  c: { header: (k: string, v: string) => void; html: (v: string) => Response },
  html: string,
  markdownPath: string,
) {
  c.header(
    'Link',
    `<${markdownPath}>; rel="alternate"; type="text/markdown", </llms.txt>; rel="describedby"`,
  );
  return c.html(html);
}

/** Best-effort HTML → Markdown so agents can fetch /terms.md without scraping chrome. */
function htmlMainToMarkdown(html: string): string {
  const main = html.match(/<main\b[\s\S]*?<\/main>/i)?.[0] ?? html;
  const decoded = main
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<a class="(?:skip-link|home)"[\s\S]*?<\/a>/gi, '')
    .replace(/<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')
    .replace(/<strong>([\s\S]*?)<\/strong>/gi, '**$1**')
    .replace(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi, '# $1\n\n')
    .replace(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi, '## $1\n\n')
    .replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi, '$1\n\n')
    .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n')
    .replace(/<\/?(?:ul|ol|main|div|span|hr)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return `${decoded}\n`;
}

export function marketingRoutes() {
  const app = new Hono();
  app.get('/', (c) => {
    // Inject the live command catalog so marketing never drifts from the parser.
    const html = staticPage('marketing.html', 'Orvex Review').replace(
      '<!--ORVEX_COMMANDS_ROWS-->',
      formatCommandsHtmlRows('@orvex'),
    );
    return sendHtml(c, html, '/index.md');
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
  app.get('/terms', (c) => sendHtml(c, staticPage('terms.html', 'Terms of Service'), '/terms.md'));
  app.get('/privacy', (c) =>
    sendHtml(c, staticPage('privacy.html', 'Privacy Policy'), '/privacy.md'),
  );
  app.get('/refunds', (c) =>
    sendHtml(c, staticPage('refunds.html', 'Refund Policy'), '/refunds.md'),
  );
  app.get('/index.md', (c) => sendMarkdown(c, staticPlain('index.md')));
  app.get('/terms.md', (c) =>
    sendMarkdown(c, htmlMainToMarkdown(staticPage('terms.html', 'Terms of Service'))),
  );
  app.get('/privacy.md', (c) =>
    sendMarkdown(c, htmlMainToMarkdown(staticPage('privacy.html', 'Privacy Policy'))),
  );
  app.get('/refunds.md', (c) =>
    sendMarkdown(c, htmlMainToMarkdown(staticPage('refunds.html', 'Refund Policy'))),
  );

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
        '# AI briefing files (not crawl-control): https://useorvex.com/llms.txt',
        '# Full briefing: https://useorvex.com/llms-full.txt',
        '# GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot, Claude-SearchBot,',
        '# PerplexityBot, Google-Extended, Googlebot, Bingbot, Applebot, and',
        '# Yandex follow User-agent: *. Do not add named Allow: / groups;',
        '# those would skip the Disallow rules below.',
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
    const lastmod = '2026-08-15';
    const pages: Array<{ path: string; changefreq: string; priority: string }> = [
      { path: '/', changefreq: 'weekly', priority: '1.0' },
      { path: '/terms', changefreq: 'monthly', priority: '0.5' },
      { path: '/privacy', changefreq: 'monthly', priority: '0.5' },
      { path: '/refunds', changefreq: 'monthly', priority: '0.5' },
    ];
    const urls = pages
      .map(
        (p) =>
          `  <url><loc>https://useorvex.com${p.path}</loc><lastmod>${lastmod}</lastmod><changefreq>${p.changefreq}</changefreq><priority>${p.priority}</priority></url>`,
      )
      .join('\n');
    c.header('Content-Type', 'application/xml; charset=utf-8');
    c.header('Cache-Control', 'public, max-age=86400');
    return c.body(
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
    );
  });

  app.get('/llms.txt', (c) => {
    c.header('Content-Type', 'text/plain; charset=utf-8');
    c.header('Cache-Control', 'public, max-age=86400');
    return c.body(staticPlain('llms.txt'));
  });
  app.get('/llms-full.txt', (c) => {
    c.header('Content-Type', 'text/plain; charset=utf-8');
    c.header('Cache-Control', 'public, max-age=86400');
    return c.body(staticPlain('llms-full.txt'));
  });

  return app;
}
