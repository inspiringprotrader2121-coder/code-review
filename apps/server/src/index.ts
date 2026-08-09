import 'dotenv/config';
import { serve } from '@hono/node-server';
import { authDisabled, legacyAuthMode } from '@orvex-review/tenants';
import { composeApplication } from './bootstrap/composition.js';
import { isLoopbackHost, loadServerRuntimeConfig } from './bootstrap/config.js';
import { startApplicationLifecycle } from './bootstrap/lifecycle.js';

const runtime = loadServerRuntimeConfig();
const { host, port } = runtime;

// FAIL CLOSED: refuse to serve the dashboard on a public interface with no
// authentication configured. Prod sets ORVEX_REQUIRE_LOGIN=1 (or OAuth), so this
// never fires there — it's a backstop so a future deploy that drops the auth env
// can't silently expose every tenant's data. Override only for a deliberate
// public demo with ORVEX_ALLOW_PUBLIC_NOLOGIN=1.
const isLoopbackBind = isLoopbackHost(host);
// AUTH_DISABLED makes every request the shared `dev` user — never allow that on
// a non-loopback bind (legacyAuthMode() is false when AUTH_DISABLED=1, so the
// check below would otherwise miss it).
if (!isLoopbackBind && authDisabled()) {
  throw new Error(
    `Refusing to bind ${host}:${port} with AUTH_DISABLED=1 (every request is auto-authed as "dev"). ` +
      `Unset AUTH_DISABLED, or bind to 127.0.0.1 for local bypass.`,
  );
}
if (!isLoopbackBind && legacyAuthMode() && !runtime.allowPublicNoLogin) {
  throw new Error(
    `Refusing to bind ${host}:${port} with NO authentication (legacy no-login mode). ` +
      `Set ORVEX_REQUIRE_LOGIN=1 (or configure GitHub OAuth), bind to 127.0.0.1, ` +
      `or set ORVEX_ALLOW_PUBLIC_NOLOGIN=1 to override.`,
  );
}

const { db: bootDb, queue, app } = composeApplication(runtime);
const lifecycle = await startApplicationLifecycle(bootDb, queue, runtime.staleRunMs);

console.log(`[server] Orvex Review listening on http://${host}:${port}`);

serve({ fetch: app.fetch, port, hostname: host });

async function shutdown() {
  await lifecycle.shutdown();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
