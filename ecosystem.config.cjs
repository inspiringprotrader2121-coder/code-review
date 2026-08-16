/**
 * Production PM2 multi-app topology (same host, SQLite OK).
 *
 * Roles:
 *   - velatrix-api         HTTP / webhooks / dashboard
 *   - velatrix-scheduler   fleet capacity registry + recovery + nightly
 *   - velatrix-worker-NN   review execution (hardware-bound; per-client caps stay)
 *
 * Software slot counts are set above host RAM/CPU/disk so host-admission is the
 * first fleet-wide stop. Per-tenant Redis fairness and plan concurrent/hourly
 * caps still apply. Fleet provider ceilings stay in Redis under
 * ORVEX_FLEET_CAPACITY_EPOCH.
 *
 * Each worker drains for up to ORVEX_SHUTDOWN_DRAIN_MS before kill.
 * Keep PM2 kill_timeout above that drain window.
 *
 * deploy-safe.sh starts/stops/restarts the full multi-app set from this file
 * and deletes the legacy `velatrix-review` process name on cutover.
 */

const ROOT = '/home/orvex/code-review';
const WORKER_COUNT = 13;
const REVIEWS_PER_WORKER = 10_000;

const SHARED_FLEET = [
  'ORVEX_REQUIRE_DURABLE_STORAGE=1',
  // Fleet Redis ceilings sit far above host RAM so hardware binds first.
  'ORVEX_FLEET_PROVIDER_CONCURRENCY_LUNA=10000',
  'ORVEX_FLEET_PROVIDER_CONCURRENCY_DEEPSEEK=10000',
  'ORVEX_FLEET_PROVIDER_CONCURRENCY_MINIMAX=10000',
  // One tenant cannot occupy every worker slot; per-client plan caps stay tighter.
  'ORVEX_FLEET_TENANT_CONCURRENCY=8',
  'ORVEX_PROVIDER_LEASE_WAIT_MS=600000',
  'ORVEX_FLEET_CAPACITY_EPOCH=review-scale-v4',
  'ORVEX_VERIFY_CONCURRENCY=10000',
  'ORVEX_MAX_SANDBOXES=10000',
  'ORVEX_SANDBOX_SLOT_DIR=/home/orvex/orvex-data/sandbox-slots',
  'ORVEX_SHUTDOWN_DRAIN_MS=960000',
  'ORVEX_LEASE_RENEW_MS=60000',
  'ORVEX_MONTHLY_COGS_CAP_USD=5000',
  // Immutable live .env still has 64k; these must follow `. ./.env` so Luna,
  // DeepSeek, and MiniMax actually request 128k output tokens.
  'ORVEX_MAX_OUTPUT_TOKENS=128000',
  'ORVEX_MAX_OUTPUT_TOKENS_CAP=128000',
  'ORVEX_UNLIMITED_GITHUB_OWNERS=inspiringprotrader2121-coder',
  'ORVEX_UNLIMITED_ACCOUNT_EMAILS=inspiringprotrader2121@gmail.com',
  'ORVEX_UNLIMITED_TENANT_SLUGS=org-inspiringprotrader2121-coder,inspiringprotrader2121-coder',
  // Pin after `. ./.env` so a live `=0` cannot turn the hardware gate off.
  'ORVEX_HOST_MIN_AVAILABLE_MEMORY_BYTES=1073741824',
  'ORVEX_HOST_MIN_AVAILABLE_DISK_BYTES=2147483648',
].join(' ');

const WORKER_LOCAL = [
  `ORVEX_MAX_CONCURRENT_REVIEWS=${REVIEWS_PER_WORKER}`,
  `ORVEX_REVIEW_CONCURRENCY=${REVIEWS_PER_WORKER}`,
  // Per-process protective ceilings; host memory/disk refuse new claims first.
  `ORVEX_CODEX_APIKEY_CONCURRENCY=${REVIEWS_PER_WORKER}`,
  `ORVEX_PROVIDER_CONCURRENCY_LUNA=${REVIEWS_PER_WORKER}`,
  `ORVEX_PROVIDER_CONCURRENCY_DEEPSEEK=${REVIEWS_PER_WORKER}`,
  `ORVEX_PROVIDER_CONCURRENCY_MINIMAX=${REVIEWS_PER_WORKER}`,
].join(' ');

function bashArgs(envInline) {
  return `-lc "cd ${ROOT} && set -a && . ./.env && set +a && NODE_ENV=production ${envInline} pnpm start"`;
}

const commonProcess = {
  cwd: ROOT,
  script: '/usr/bin/bash',
  interpreter: 'none',
  kill_timeout: 1_020_000,
  kill_retry_time: 10_000,
  listen_timeout: 30_000,
  min_uptime: 10_000,
  max_restarts: 10,
  autorestart: true,
  watch: false,
  treekill: true,
};

function app(name, envInline, extras = {}) {
  return {
    name,
    ...commonProcess,
    args: bashArgs(envInline),
    env: {
      NODE_ENV: 'production',
      ORVEX_REQUIRE_DURABLE_STORAGE: '1',
      ...(extras.env ?? {}),
    },
    ...Object.fromEntries(Object.entries(extras).filter(([key]) => key !== 'env')),
  };
}

const api = app('velatrix-api', `ORVEX_PROCESS_ROLE=api PORT=8788 HOST=0.0.0.0 ${SHARED_FLEET}`, {
  env: { HOST: '0.0.0.0', PORT: '8788', ORVEX_PROCESS_ROLE: 'api' },
});

const scheduler = app(
  'velatrix-scheduler',
  `ORVEX_PROCESS_ROLE=scheduler ORVEX_WORKER_ID=scheduler-01 ${SHARED_FLEET}`,
  {
    env: { ORVEX_PROCESS_ROLE: 'scheduler', ORVEX_WORKER_ID: 'scheduler-01' },
  },
);

const workers = Array.from({ length: WORKER_COUNT }, (_, index) => {
  const n = String(index + 1).padStart(2, '0');
  const workerId = `review-worker-${n}`;
  return app(
    `velatrix-worker-${n}`,
    `ORVEX_PROCESS_ROLE=worker ORVEX_WORKER_ID=${workerId} ${WORKER_LOCAL} ${SHARED_FLEET}`,
    {
      env: { ORVEX_PROCESS_ROLE: 'worker', ORVEX_WORKER_ID: workerId },
      // Bound a single worker OOM so it cannot take down the API process.
      max_memory_restart: '3G',
    },
  );
});

module.exports = {
  apps: [api, scheduler, ...workers],
};
