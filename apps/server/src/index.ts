import 'dotenv/config';
import { serve } from '@hono/node-server';
import { createReviewQueue } from '@velatrix-review/queue';
import { createApp } from './app.js';
import { startWorkerLoop } from './queue-runner.js';

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '0.0.0.0';

const queue = createReviewQueue();
const app = createApp(queue);
const stopWorker = startWorkerLoop(queue);

console.log(`[server] Velatrix Review listening on http://${host}:${port}`);

serve({ fetch: app.fetch, port, hostname: host });

async function shutdown() {
  console.log('[server] shutting down…');
  stopWorker();
  await queue.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
