import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';

// This module runs from src/assets under tsx and dist/assets after compilation.
// Resolve back to the deployed source bundle in either case; deploys deliberately
// do not sync dist, and TypeScript does not copy non-code assets into it.
export function resolveAssetDirectory(moduleUrl: string = import.meta.url): string {
  return path.resolve(fileURLToPath(new URL('.', moduleUrl)), '../../src/assets');
}

const assetDirectory = resolveAssetDirectory();

const assets = {
  'dashboard.css': 'text/css; charset=utf-8',
  'dashboard.js': 'text/javascript; charset=utf-8',
  'legal.css': 'text/css; charset=utf-8',
  'marketing.css': 'text/css; charset=utf-8',
  'marketing.js': 'text/javascript; charset=utf-8',
  'shell.css': 'text/css; charset=utf-8',
  'superadmin.css': 'text/css; charset=utf-8',
  'superadmin.js': 'text/javascript; charset=utf-8',
} as const;

type AssetName = keyof typeof assets;

/** Fixed-name application assets, served from the source bundle with revalidation. */
export function assetRoutes() {
  const app = new Hono();
  app.get('/assets/:name', (c) => {
    const name = c.req.param('name') as AssetName;
    const contentType = assets[name];
    if (!contentType) return c.notFound();
    try {
      const body = readFileSync(path.join(assetDirectory, name));
      c.header('Content-Type', contentType);
      c.header('Cache-Control', 'public, max-age=0, must-revalidate');
      return c.body(body);
    } catch {
      return c.notFound();
    }
  });
  return app;
}

export function assetHref(name: AssetName): string {
  return `/assets/${name}`;
}
