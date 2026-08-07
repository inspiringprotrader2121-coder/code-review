/**
 * Production PM2 definition.
 *
 * The worker drains for up to ORVEX_SHUTDOWN_DRAIN_MS before it is killed.
 * Keep PM2's termination window above that drain window so deploys do not
 * interrupt a review after the queue has stopped accepting new work.
 */
module.exports = {
  apps: [
    {
      name: 'velatrix-review',
      script: '/usr/bin/bash',
      args: '-lc "cd /home/orvex/code-review && set -a && . ./.env && set +a && NODE_ENV=production ORVEX_REQUIRE_DURABLE_STORAGE=1 PORT=8788 HOST=0.0.0.0 pnpm start"',
      cwd: '/home/orvex/code-review',
      interpreter: 'none',
      env: {
        NODE_ENV: 'production',
        ORVEX_REQUIRE_DURABLE_STORAGE: '1',
        HOST: '0.0.0.0',
        PORT: '8788',
      },
      kill_timeout: 1_020_000,
      kill_retry_time: 10_000,
      listen_timeout: 30_000,
      min_uptime: 10_000,
      max_restarts: 10,
      autorestart: true,
      watch: false,
      treekill: true,
    },
  ],
};
