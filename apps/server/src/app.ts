import { Hono } from 'hono';
import type { ReviewQueue } from '@orvex-review/queue';
import { createAppDatabase } from '@orvex-review/store';
import { apiRoutes } from './routes/api.js';
import { authRoutes } from './routes/auth.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { marketingRoutes } from './routes/marketing.js';
import { sessionRoutes } from './routes/session.js';
import { webhookRoutes } from './routes/webhook.js';

export function createApp(queue: ReviewQueue) {
  const app = new Hono();

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
    return c.json({ ok, db: dbOk ? 'ok' : 'down', queue: queueOk ? 'ok' : 'down' }, ok ? 200 : 503);
  });

  app.route('/', marketingRoutes());
  app.route('/', sessionRoutes());
  app.route('/', dashboardRoutes());
  app.route('/', authRoutes());
  app.route('/', apiRoutes());
  app.route('/', webhookRoutes(queue));

  return app;
}
