import { Hono } from 'hono';
import type { ReviewQueue } from '@velatrix-review/queue';
import { authRoutes } from './routes/auth.js';
import { webhookRoutes } from './routes/webhook.js';

export function createApp(queue: ReviewQueue) {
  const app = new Hono();

  app.get('/health', (c) =>
    c.json({
      ok: true,
      service: 'velatrix-review',
      mode: 'multi-tenant',
      connect: '/dashboard',
      install: '/connect',
    }),
  );

  app.route('/', authRoutes());
  app.route('/', webhookRoutes(queue));

  return app;
}
