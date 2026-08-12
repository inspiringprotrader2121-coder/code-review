/**
 * Production PM2 multi-app topology (same host, SQLite OK).
 *
 * Roles:
 *   - velatrix-api         HTTP / webhooks / dashboard
 *   - velatrix-scheduler   fleet capacity registry + recovery + nightly
 *   - velatrix-worker-NN   review execution (8 concurrent reviews each)
 *
 * Fleet provider ceilings stay in Redis under ORVEX_FLEET_CAPACITY_EPOCH.
 * Local ORVEX_MAX_CONCURRENT_REVIEWS is per worker process (4–8).
 *
 * Each worker drains for up to ORVEX_SHUTDOWN_DRAIN_MS before kill.
 * Keep PM2 kill_timeout above that drain window.
 *
 * deploy-safe.sh starts/stops/restarts the full multi-app set from this file
 * and deletes the legacy `velatrix-review` process name on cutover.
 */

const ROOT = '/home/orvex/code-review';
const WORKER_COUNT = 13;
const REVIEWS_PER_WORKER = 8;

const SHARED_FLEET = [
  'ORVEX_REQUIRE_DURABLE_STORAGE=1',
  'ORVEX_FLEET_PROVIDER_CONCURRENCY_LUNA=100',
  'ORVEX_FLEET_PROVIDER_CONCURRENCY_DEEPSEEK=128',
  'ORVEX_FLEET_PROVIDER_CONCURRENCY_MINIMAX=100',
  'ORVEX_FLEET_TENANT_CONCURRENCY=40',
  'ORVEX_PROVIDER_LEASE_WAIT_MS=600000',
  'ORVEX_FLEET_CAPACITY_EPOCH=review-scale-v1',
  'ORVEX_VERIFY_CONCURRENCY=32',
  'ORVEX_MAX_SANDBOXES=32',
  'ORVEX_SANDBOX_SLOT_DIR=/home/orvex/orvex-data/sandbox-slots',
  'ORVEX_SHUTDOWN_DRAIN_MS=960000',
  'ORVEX_LEASE_RENEW_MS=60000',
  'ORVEX_MONTHLY_COGS_CAP_USD=5000',
].join(' ');

const WORKER_LOCAL = [
  `ORVEX_MAX_CONCURRENT_REVIEWS=${REVIEWS_PER_WORKER}`,
  'ORVEX_REVIEW_CONCURRENCY=8',
  // Per-process protective ceilings; Redis fleet admission owns aggregate capacity.
  `ORVEX_CODEX_APIKEY_CONCURRENCY=${REVIEWS_PER_WORKER}`,
  `ORVEX_PROVIDER_CONCURRENCY_LUNA=${REVIEWS_PER_WORKER}`,
  'ORVEX_PROVIDER_CONCURRENCY_DEEPSEEK=16',
  'ORVEX_PROVIDER_CONCURRENCY_MINIMAX=12',
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
