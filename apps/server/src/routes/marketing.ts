import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The Fable-designed landing page. Loaded once; served at the app root so the
// marketing site and the app live on ONE domain (no separate api. subdomain).
let cachedHtml: string | null = null;
function marketingHtml(): string {
  if (cachedHtml === null) {
    try {
      cachedHtml = readFileSync(path.resolve(__dirname, '../../marketing.html'), 'utf8');
    } catch {
      cachedHtml = '<!doctype html><title>Orvex Review</title><h1>Orvex Review</h1><p><a href="/dashboard">Dashboard</a></p>';
    }
  }
  return cachedHtml;
}

export function marketingRoutes() {
  const app = new Hono();
  app.get('/', (c) => c.html(marketingHtml()));
  return app;
}
