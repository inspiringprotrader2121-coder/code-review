import 'dotenv/config';
import { serve } from '@hono/node-server';
import { createReviewQueue } from '@orvex-review/queue';
import { createAppDatabase } from '@orvex-review/store';
import { legacyAuthMode } from '@orvex-review/tenants';
import { createApp } from './app.js';
import { startWorkerLoop } from './queue-runner.js';
import { startNightlyScheduler } from './nightly.js';

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '0.0.0.0';

// FAIL CLOSED: refuse to serve the dashboard on a public interface with no
// authentication configured. Prod sets ORVEX_REQUIRE_LOGIN=1 (or OAuth), so this
// never fires there — it's a backstop so a future deploy that drops the auth env
// can't silently expose every tenant's data. Override only for a deliberate
// public demo with ORVEX_ALLOW_PUBLIC_NOLOGIN=1.
const isLoopbackBind = host === '127.0.0.1' || host === 'localhost' || host === '::1';
if (!isLoopbackBind && legacyAuthMode() && process.env.ORVEX_ALLOW_PUBLIC_NOLOGIN !== '1') {
  throw new Error(
    `Refusing to bind ${host}:${port} with NO authentication (legacy no-login mode). ` +
      `Set ORVEX_REQUIRE_LOGIN=1 (or configure GitHub OAuth), bind to 127.0.0.1, ` +
      `or set ORVEX_ALLOW_PUBLIC_NOLOGIN=1 to override.`,
  );
}

// Clear review rows left 'running' by a previous crash/restart so the dashboard
// doesn't show a perpetual in-progress spinner.
const bootDb = createAppDatabase();
const staleRuns = bootDb.failStaleRunningRuns();
if (staleRuns > 0) console.log(`[server] cleared ${staleRuns} stale 'running' review row(s)`);

// Bounded retention: prune ephemeral rows (skipped/failed runs, expired
// sessions, old abuse signals) at boot and daily. Never touches completed
// reviews (the lifetime trial cap needs them).
function pruneOnce(): void {
  try {
    const pruned = bootDb.pruneEphemeralData();
    if (pruned > 0) console.log(`[server] pruned ${pruned} ephemeral row(s)`);
  } catch (err) {
    console.error('[server] prune failed', err);
  }
}
pruneOnce();
const pruneTimer = setInterval(pruneOnce, 24 * 3_600_000);
pruneTimer.unref();

const queue = createReviewQueue();
const app = createApp(queue);

// Startup recovery BEFORE the worker starts: clear stale in-flight locks and
// requeue anything left pending by a prior crash/restart, so no PR is left
// silently blocked.
try {
  const recovered = await queue.recoverOrphans();
  if (recovered > 0) console.log(`[server] recovered ${recovered} orphaned/pending queue item(s)`);
} catch (err) {
  console.error('[server] queue recovery failed', err);
}

const stopWorker = startWorkerLoop(queue);
// Nightly whole-repo scans (Verify+); no-op unless ORVEX_NIGHTLY_SCANS=1.
const stopNightly = startNightlyScheduler(queue);

console.log(`[server] Orvex Review listening on http://${host}:${port}`);

serve({ fetch: app.fetch, port, hostname: host });

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('[server] shutting down…');
  stopNightly();
  await stopWorker(); // re-queues in-flight reviews so they resume after restart
  await queue.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
