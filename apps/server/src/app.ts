import { readFileSync } from 'node:fs';
import { Hono, type MiddlewareHandler } from 'hono';
import type { ReviewQueue } from '@orvex-review/queue';
import { createAppDatabase } from '@orvex-review/store';
import { appPublicUrl } from '@orvex-review/tenants';
import { apiRoutes } from './routes/api.js';
import { authRoutes } from './routes/auth.js';
import { billingRoutes } from './routes/billing.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { marketingRoutes } from './routes/marketing.js';
import { sessionRoutes } from './routes/session.js';
import { securityRoutes } from './routes/security.js';
import { webhookRoutes } from './routes/webhook.js';
import { superadminRoutes } from './routes/superadmin.js';
import { getActiveJobCount, isDeployDraining } from './queue-runner.js';

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "img-src 'self' data:",
  "font-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
].join('; ');

/** Baseline browser protections for both the public site and authenticated app. */
export const productionSecurityHeaders: MiddlewareHandler = async (c, next) => {
  c.header('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  c.header('Permissions-Policy', 'camera=(), geolocation=(), microphone=()');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('X-Permitted-Cross-Domain-Policies', 'none');
  if (
    process.env.APP_URL?.startsWith('https://') ||
    c.req.header('x-forwarded-proto')?.split(',')[0]?.trim() === 'https'
  ) {
    c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  await next();

  const path = c.req.path;
  if (/^\/(?:api(?:\/|$)|auth(?:\/|$)|buy(?:\/|$)|connect(?:\/|$)|dashboard(?:\/|$)|settings(?:\/|$)|superadmin(?:\/|$))/.test(path)) {
    c.header('Cache-Control', 'no-store');
  }
};

/** Keep OAuth cookies and callbacks on one canonical host. */
export const canonicalHostRedirect: MiddlewareHandler = async (c, next) => {
  const configured = appPublicUrl();
  let canonical: URL;
  try {
    canonical = new URL(configured);
  } catch {
    await next();
    return;
  }
  const requestHost = c.req.header('host')?.split(':')[0]?.toLowerCase();
  if (requestHost === `www.${canonical.hostname}`) {
    const target = new URL(c.req.url);
    target.protocol = canonical.protocol;
    target.hostname = canonical.hostname;
    target.port = canonical.port;
    return c.redirect(target.toString(), 308);
  }
  await next();
};

export function createApp(queue: ReviewQueue) {
  const app = new Hono();
  app.use('*', productionSecurityHeaders);
  app.use('*', canonicalHostRedirect);

  // Shallow liveness — the process is up (for a load balancer's basic check).
  app.get('/health', (c) => c.json({ ok: true, service: 'orvex-review', mode: 'multi-tenant', connect: '/connect' }));

  // Deep readiness — actually probe the DB and the queue backend so a monitor
  // can tell a half-dead instance (DB locked, Redis down) from a healthy one.
  // Returns 503 if any dependency is unreachable.
  app.get('/ready', async (c) => {
    let dbOk = false;
    let queueOk = false;
    try {
      createAppDatabase().pingDb();
      dbOk = true;
    } catch {
      /* dbOk stays false */
    }
    try {
      queueOk = await queue.ping();
    } catch {
      /* queueOk stays false */
    }
    const ok = dbOk && queueOk;
    // activeJobs lets deploys WAIT FOR IDLE before restarting (deploy-safe.sh):
    // restarting mid-review discards work and can kill codex mid token-refresh,
    // invalidating its OAuth session.
    // codexAuth comes from the 10-minute watchdog's status file (ok | dead |
    // unknown) — a revoked OAuth session shows here instead of hiding in a log.
    let codexAuth = 'unknown';
    try {
      const raw = readFileSync(process.env.ORVEX_CODEX_STATUS_FILE ?? '/home/orvex/orvex-data/codex-auth-status', 'utf8');
      codexAuth = raw.trim().split(/\s+/)[0] || 'unknown';
    } catch {
      /* watchdog hasn't run yet */
    }
    return c.json(
      {
        ok,
        db: dbOk ? 'ok' : 'down',
        queue: queueOk ? 'ok' : 'down',
        activeJobs: getActiveJobCount(),
        draining: isDeployDraining(),
        codexAuth,
      },
      ok ? 200 : 503,
    );
  });

  app.route('/', marketingRoutes());
  app.route('/', sessionRoutes());
  app.route('/', securityRoutes());
  app.route('/', dashboardRoutes());
  app.route('/', authRoutes());
  app.route('/', billingRoutes());
  app.route('/', apiRoutes());
  app.route('/', webhookRoutes(queue));
  // operator-only tooling (scoreboard etc.) — secret-gated, never tenant-facing
  app.route('/', superadminRoutes());

  return app;
}
