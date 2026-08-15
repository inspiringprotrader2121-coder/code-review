import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Hono, type MiddlewareHandler } from 'hono';
import type { ReviewQueue } from '@orvex-review/queue';
import type { AppDatabase } from '@orvex-review/store';
import type { GitHubAppConfig } from '@orvex-review/github';
import { apiRoutes } from './routes/api.js';
import { authRoutes } from './routes/auth.js';
import { billingRoutes } from './routes/billing.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { marketingRoutes } from './routes/marketing.js';
import { sessionRoutes } from './routes/session.js';
import { securityRoutes } from './routes/security.js';
import { webhookRoutes } from './routes/webhook.js';
import { superadminRoutes } from './routes/superadmin.js';
import { assetRoutes } from './assets/index.js';
import { enqueueManualReview, getActiveJobCount, isDeployDraining } from './queue-runner.js';
import { type ServerConfig } from './bootstrap/config.js';
import { processRoleRunsHttp } from './bootstrap/topology.js';

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'none'",
  // /connect's "Continue to GitHub" form GETs /auth/github/install, which 302s
  // to github.com (OAuth proof, then the App install page). Browsers apply
  // form-action to that whole redirect chain, so GitHub must be listed or the
  // button appears to do nothing.
  "form-action 'self' https://github.com",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "img-src 'self' data:",
  "font-src 'self'",
  // Legacy form and recovery-code markup still has a small, finite set of
  // static style attributes. Hash them rather than retaining unsafe-inline.
  "style-src 'self' 'unsafe-hashes' 'sha256-jPXNxcBeSFISIJqsNSUsyMFzgujZMPl1b/AabXorOMg=' 'sha256-aD0Kjf1bhdeolz4od0LZ2hxNgF9jFvaierm7xGYksiQ=' 'sha256-/sufNjN/Q1ave/eUvxrOc0V0hShu9n+o8++xysBP94E=' 'sha256-stTDGS+M4Ju9RwHc2Gf9dwL0WerJaH3LMb8KyYLDw8I=' 'sha256-xT6h2iOFCmc+b0YYoNajguP1/DpiqxRRQMAc8B17igQ=' 'sha256-ksGPa9rBx3qdJd85P0QDyQNATrJagvS5YtLUpHxWuto=' 'sha256-K9+ORf38cBZRtn9YJ8PSd1A5CUefJHMOT3UAae8AuDw=' 'sha256-PUlKrXE/Ygg7wwoDjjqa9KY74NV4yRkciX1VVBXJOtw=' 'sha256-kFAIUwypIt04FgLyVU63Lcmp2AQimPh/TdYjy04Flxs=' 'sha256-iA+6U0eo8g/wYg081LYADnHLoToHiLxt7Xev/BqZh30=' 'sha256-F70OcAihAGiJqE5jXud4Bdv+Zgoy4cgEZ0w+cC85HY4='",
  "script-src 'self'",
  "connect-src 'self'",
].join('; ');

/** Baseline browser protections for both the public site and authenticated app. */
export function productionSecurityHeaders(config: ServerConfig): MiddlewareHandler {
  return async (c, next) => {
    c.header('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    c.header('Permissions-Policy', 'camera=(), geolocation=(), microphone=()');
    c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header('X-Permitted-Cross-Domain-Policies', 'none');
    if (
      config.appUrl.startsWith('https://') ||
      c.req.header('x-forwarded-proto')?.split(',')[0]?.trim() === 'https'
    ) {
      c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    await next();

    const path = c.req.path;
    if (
      /^\/(?:api(?:\/|$)|auth(?:\/|$)|buy(?:\/|$)|connect(?:\/|$)|dashboard(?:\/|$)|settings(?:\/|$)|superadmin(?:\/|$))/.test(
        path,
      )
    ) {
      c.header('Cache-Control', 'no-store');
    }
  };
}

/** Keep OAuth cookies and callbacks on one canonical host. */
export function canonicalHostRedirect(config: ServerConfig): MiddlewareHandler {
  return async (c, next) => {
    const configured = config.appUrl;
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
}

export interface CreateAppDependencies {
  db: AppDatabase;
  config: ServerConfig;
  githubConfig?: GitHubAppConfig;
  /** Non-secret release metadata written alongside the deployed application. */
  releaseFile?: string;
}

const RELEASE_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
export const DEFAULT_RELEASE_FILE = fileURLToPath(
  new URL('../../../release.json', import.meta.url),
);

/**
 * Return only the safe release identifier from deployment metadata. Readiness
 * must never expose the complete file because future metadata may grow.
 */
export function readReleaseId(file: string): string {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'unknown';
    const metadata = parsed as Record<string, unknown>;
    for (const key of ['releaseId', 'commitSha', 'commit']) {
      const value = metadata[key];
      if (typeof value === 'string' && RELEASE_ID_PATTERN.test(value)) return value;
    }
  } catch {
    // A missing or incomplete metadata file must not make a healthy service unready.
  }
  return 'unknown';
}

interface DependencyReadiness {
  dbOk: boolean;
  queueOk: boolean;
  globalInFlight: number;
}

async function probeDependencyReadiness(
  db: AppDatabase,
  queue: ReviewQueue,
  includeQueueDepth: boolean,
): Promise<DependencyReadiness> {
  let dbOk = false;
  let queueOk = false;
  let globalInFlight = 0;
  try {
    db.pingDb();
    dbOk = true;
  } catch {
    /* dbOk stays false */
  }
  try {
    queueOk = await queue.ping();
    // Redis PROCESSING is shared by all PM2 workers. Reading it here makes
    // deploy-safe wait for work owned by another process rather than trusting
    // only the process which happened to answer this HTTP request.
    if (includeQueueDepth && queueOk && queue.depth) {
      globalInFlight = (await queue.depth()).inFlight;
    }
  } catch {
    queueOk = false;
  }
  return { dbOk, queueOk, globalInFlight };
}

export function createApp(queue: ReviewQueue, dependencies: CreateAppDependencies) {
  const app = new Hono();
  const { db, config } = dependencies;
  app.use('*', productionSecurityHeaders(config));
  app.use('*', canonicalHostRedirect(config));

  // Shallow liveness — the process is up (for a load balancer's basic check).
  app.get('/health', (c) =>
    c.json({ ok: true, service: 'orvex-review', mode: 'multi-tenant', connect: '/connect' }),
  );

  // Deep readiness — actually probe the DB and the queue backend so a monitor
  // can tell a half-dead instance (DB locked, Redis down) from a healthy one.
  // Returns 503 if any dependency is unreachable.
  app.get('/ready', async (c) => {
    const { dbOk, queueOk, globalInFlight } = await probeDependencyReadiness(db, queue, true);
    const ok = dbOk && queueOk;
    // activeJobs lets deploys WAIT FOR IDLE before restarting (deploy-safe.sh):
    // restarting mid-review discards work and can kill codex mid token-refresh,
    // invalidating its OAuth session.
    // codexAuth comes from the 10-minute watchdog's status file (ok | dead |
    // unknown) — a revoked OAuth session shows here instead of hiding in a log.
    let codexAuth = 'unknown';
    try {
      const raw = readFileSync(config.codexStatusFile, 'utf8');
      codexAuth = raw.trim().split(/\s+/)[0] || 'unknown';
    } catch {
      /* watchdog hasn't run yet */
    }
    return c.json(
      {
        ok,
        db: dbOk ? 'ok' : 'down',
        queue: queueOk ? 'ok' : 'down',
        activeJobs: Math.max(getActiveJobCount(), globalInFlight),
        draining: isDeployDraining(config),
        codexAuth,
        releaseId: readReleaseId(dependencies.releaseFile ?? DEFAULT_RELEASE_FILE),
      },
      ok ? 200 : 503,
    );
  });

  // Traffic readiness is deliberately separate from /ready. Deploy-safe keeps
  // /ready successful while a node drains active jobs; a load balancer needs a
  // 503 at that same point so it stops sending fresh webhooks and browser work.
  app.get('/traffic-ready', async (c) => {
    const { dbOk, queueOk } = await probeDependencyReadiness(db, queue, false);
    const draining = isDeployDraining(config);
    const servesHttp = processRoleRunsHttp(config.topology.role);
    const ok = dbOk && queueOk && servesHttp && !draining;
    return c.json(
      {
        ok,
        role: config.topology.role,
        db: dbOk ? 'ok' : 'down',
        queue: queueOk ? 'ok' : 'down',
        draining,
        releaseId: readReleaseId(dependencies.releaseFile ?? DEFAULT_RELEASE_FILE),
      },
      ok ? 200 : 503,
    );
  });

  app.route('/', marketingRoutes());
  app.route('/', assetRoutes());
  app.route('/', sessionRoutes({ db, config }));
  app.route('/', securityRoutes({ db, config }));
  app.route('/', dashboardRoutes({ db, config }));
  app.route('/', authRoutes({ db, config, githubConfig: dependencies.githubConfig }));
  app.route('/', billingRoutes({ db, config }));
  app.route('/', apiRoutes({ db, config, githubConfig: dependencies.githubConfig }));
  app.route(
    '/',
    webhookRoutes(queue, {
      db,
      config,
      githubConfig: dependencies.githubConfig,
      manualReview: (input) => enqueueManualReview(queue, input, db),
    }),
  );
  // operator-only tooling (scoreboard etc.) — secret-gated, never tenant-facing
  app.route('/', superadminRoutes({ db, queue, config }));

  return app;
}
