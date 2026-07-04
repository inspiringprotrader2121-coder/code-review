import { Hono } from 'hono';
import type { ReviewQueue } from '@orvex-review/queue';
import { apiRoutes } from './routes/api.js';
import { authRoutes } from './routes/auth.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { sessionRoutes } from './routes/session.js';
import { webhookRoutes } from './routes/webhook.js';

export function createApp(queue: ReviewQueue) {
  const app = new Hono();

  app.get('/health', (c) =>
    c.json({
      ok: true,
      service: 'orvex-review',
      mode: 'multi-tenant',
      connect: '/connect',
    }),
  );

  app.route('/', sessionRoutes());
  app.route('/', dashboardRoutes());
  app.route('/', authRoutes());
  app.route('/', apiRoutes());
  app.route('/', webhookRoutes(queue));

  return app;
}
