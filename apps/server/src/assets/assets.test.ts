import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { assetRoutes, resolveAssetDirectory } from './index.js';

test('compiled asset routes resolve the deployed source bundle', () => {
  const serverDirectory = path.resolve(import.meta.dirname, '../..');
  const compiledModuleUrl = pathToFileURL(path.join(serverDirectory, 'dist/assets/index.js')).href;
  assert.equal(resolveAssetDirectory(compiledModuleUrl), path.join(serverDirectory, 'src/assets'));
});

test('application assets are served externally with typed content', async () => {
  const app = assetRoutes();
  const [css, script, missing] = await Promise.all([
    app.request('/assets/dashboard.css'),
    app.request('/assets/dashboard.js'),
    app.request('/assets/not-an-asset.js'),
  ]);
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type') ?? '', /^text\/css/);
  assert.equal(css.headers.get('cache-control'), 'public, max-age=0, must-revalidate');
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type') ?? '', /^text\/javascript/);
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get('cache-control'), null);
});

test('public pages and assets remain strict-CSP compatible and accessible', () => {
  const serverDirectory = path.resolve(import.meta.dirname, '../..');
  const marketing = readFileSync(path.join(serverDirectory, 'marketing.html'), 'utf8');
  const legalPages = ['privacy.html', 'terms.html', 'refunds.html'].map((name) =>
    readFileSync(path.join(serverDirectory, name), 'utf8'),
  );
  const dashboardScript = readFileSync(path.join(import.meta.dirname, 'dashboard.js'), 'utf8');
  const marketingScript = readFileSync(path.join(import.meta.dirname, 'marketing.js'), 'utf8');

  for (const page of [marketing, ...legalPages]) {
    assert.match(page, /class="skip-link" href="#main-content"/);
    assert.match(page, /<main id="main-content" tabindex="-1">/);
    assert.doesNotMatch(page, /\s(?:on\w+|style)\s*=/i);
    assert.doesNotMatch(page, /javascript:/i);
  }
  assert.match(marketing, /<script type="application\/ld\+json">/);
  assert.match(marketing, /<script src="\/assets\/marketing\.js" defer><\/script>/);
  assert.equal(
    (
      marketing.match(/<script(?! type="application\/ld\+json"| src="\/assets\/marketing\.js")/g) ??
      []
    ).length,
    0,
  );
  assert.match(marketing, /aria-pressed="false"/);
  assert.match(marketingScript, /setAttribute\(["']aria-pressed["']/);
  assert.match(dashboardScript, /const\s+finiteNumber\s*=/);
  assert.match(dashboardScript, /const\s+wholeNumber\s*=/);
  assert.match(dashboardScript, /event\.key\s*===\s*["']ArrowDown["']/);
  assert.match(dashboardScript, /activeElementIsInside/);
  assert.doesNotMatch(dashboardScript, /tip\.innerHTML/);
});
