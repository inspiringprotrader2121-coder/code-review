import assert from 'node:assert/strict';
import test from 'node:test';
import { isLoopbackHost, loadServerConfig } from './config.js';

test('server config preserves defaults, aliases, and immutable nested values', () => {
  const config = loadServerConfig({});
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 8787);
  assert.equal(config.appUrl, 'http://localhost:8787');
  assert.equal(config.worker.concurrency, 8);
  assert.equal(config.hostAdmission.minAvailableMemoryBytes, 1_073_741_824);
  assert.equal(config.hostAdmission.minAvailableDiskBytes, 2_147_483_648);
  assert.equal(config.topology.role, 'all');
  assert.equal(config.webhook.bodyDedupTtlMs, 2 * 3_600_000);
  assert.equal(config.store.databasePath, config.databasePath);
  assert.equal(config.store.checkoutRoot, process.cwd());
  assert.equal(config.store.requireDurableStorage, false);
  assert.equal(config.store.defaultPlan, 'free');
  assert.deepEqual(config.identity.trustedProxyIps, []);
  assert.equal(config.sandbox.sandbox.codeExecutionEnabled, false);
  assert.equal(config.sandbox.sandbox.codexContainerEnabled, false);
  assert.equal(config.sandbox.runtimeVerify.stepTimeoutMs, 240_000);
  assert.equal(config.verificationEnabled, true);
  assert.ok(Object.isFrozen(config));
  assert.ok(Object.isFrozen(config.worker));
  assert.ok(Object.isFrozen(config.hostAdmission));
  assert.ok(Object.isFrozen(config.oauth));
  assert.ok(Object.isFrozen(config.store));
  assert.ok(Object.isFrozen(config.sandbox));
  assert.ok(Object.isFrozen(config.sandbox.sandbox));
  assert.ok(Object.isFrozen(config.sandbox.runtimeVerify));
  assert.ok(Object.isFrozen(config.sandbox.codexContainer));
});

test('server config clamps malformed operational values and snapshots auth aliases', () => {
  const config = loadServerConfig({
    HOST: ' 127.0.0.1 ',
    PORT: '99999',
    ORVEX_ALLOW_PUBLIC_NOLOGIN: '1',
    ORVEX_RUNNING_STALE_MS: '10',
    ORVEX_CODEX_STATUS_FILE: '/tmp/codex-status',
    GITHUB_WEBHOOK_SECRET: 'webhook-fallback',
    ORVEX_MAX_CONCURRENT_REVIEWS: '1000',
    ORVEX_WORKER_ID: 'worker-a',
    ORVEX_PROCESS_ROLE: 'worker',
    ORVEX_CHECKOUT_ROOT: '/tmp/orvex-checkout',
    ORVEX_REQUIRE_DURABLE_STORAGE: '0',
    ORVEX_DEFAULT_PLAN: 'verify',
    ORVEX_CODE_EXECUTION: '1',
    ORVEX_CODEX_CONTAINER_RUNTIME: '1',
    ORVEX_SANDBOX_IMAGE: `runtime@sha256:${'a'.repeat(64)}`,
    ORVEX_CODEX_EGRESS_BROKER_IMAGE: `broker@sha256:${'b'.repeat(64)}`,
    DOCKER_HOST: 'unix:///run/user/1000/docker.sock',
    DOCKER_CONTEXT: 'forbidden-context',
    ORVEX_MAX_SANDBOXES: '7',
    ORVEX_SANDBOX_SLOT_WAIT_MS: '45000',
    ORVEX_SANDBOX_WORKDIR_MAX_BYTES: '1234567',
    ORVEX_SANDBOX_STEP_TIMEOUT_MS: '120000',
    ORVEX_SANDBOX_INSTALL_TIMEOUT_MS: '180000',
    ORVEX_VERIFY: '0',
    ORVEX_TRUSTED_PROXY_IPS: '127.0.0.1, ::1',
  });
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 65_535);
  assert.equal(config.allowPublicNoLogin, true);
  assert.equal(config.staleRunMs, 60_000);
  assert.equal(config.codexStatusFile, '/tmp/codex-status');
  assert.equal(config.platformSecret, 'webhook-fallback');
  assert.equal(config.worker.concurrency, 100);
  assert.equal(config.topology.role, 'worker');
  assert.equal(config.store.workerIdBase, 'worker-a');
  assert.equal(config.store.checkoutRoot, '/tmp/orvex-checkout');
  assert.equal(config.store.requireDurableStorage, false);
  assert.equal(config.store.defaultPlan, 'verify');
  assert.equal(config.sandbox.sandbox.codeExecutionEnabled, true);
  assert.equal(config.sandbox.sandbox.codexContainerEnabled, true);
  assert.equal(config.sandbox.sandbox.maxConcurrentSandboxes, 7);
  assert.equal(config.sandbox.sandbox.slotWaitMs, 45_000);
  assert.equal(config.sandbox.sandbox.workdirMaxBytes, 1_234_567);
  assert.equal(config.sandbox.sandbox.dockerHost, 'unix:///run/user/1000/docker.sock');
  assert.equal(config.sandbox.sandbox.dockerContext, 'forbidden-context');
  assert.equal(config.sandbox.runtimeVerify.stepTimeoutMs, 120_000);
  assert.equal(config.sandbox.runtimeVerify.installTimeoutMs, 180_000);
  assert.equal(config.verificationEnabled, false);
  assert.deepEqual(config.identity.trustedProxyIps, ['127.0.0.1', '::1']);
});

test('production cannot use checkout-local or relative storage', () => {
  assert.throws(
    () =>
      loadServerConfig({
        NODE_ENV: 'production',
        PLATFORM_SECRET: 'a'.repeat(32),
        STORE_PATH: './app.db',
      }),
    /STORE_PATH must be an absolute path/,
  );
});

test('production and explicit public binds require an explicit high-entropy platform secret', () => {
  assert.throws(() => loadServerConfig({ NODE_ENV: 'production' }), /PLATFORM_SECRET/);
  assert.throws(
    () => loadServerConfig({ HOST: '0.0.0.0', PLATFORM_SECRET: 'too-short' }),
    /PLATFORM_SECRET/,
  );
  assert.throws(
    () =>
      loadServerConfig({
        NODE_ENV: 'production',
        GITHUB_WEBHOOK_SECRET: 'w'.repeat(64),
      }),
    /PLATFORM_SECRET/,
  );
  assert.doesNotThrow(() =>
    loadServerConfig({
      NODE_ENV: 'production',
      PLATFORM_SECRET: 'p'.repeat(32),
      STORE_PATH: '/var/lib/orvex/app.db',
    }),
  );
  assert.doesNotThrow(() => loadServerConfig({ HOST: '127.0.0.1' }));
});

test('dedicated production worker and scheduler roles require a stable identity', () => {
  const production = {
    NODE_ENV: 'production',
    PLATFORM_SECRET: 'p'.repeat(32),
    STORE_PATH: '/var/lib/orvex/app.db',
  };
  assert.throws(
    () => loadServerConfig({ ...production, ORVEX_PROCESS_ROLE: 'worker' }),
    /ORVEX_WORKER_ID is required/,
  );
  assert.throws(
    () => loadServerConfig({ ...production, ORVEX_PROCESS_ROLE: 'scheduler' }),
    /ORVEX_WORKER_ID is required/,
  );
  assert.equal(
    loadServerConfig({
      ...production,
      ORVEX_PROCESS_ROLE: 'worker',
      ORVEX_WORKER_ID: 'review-worker-01',
    }).store.workerIdBase,
    'review-worker-01',
  );
});

test('loopback binding recognition is explicit', () => {
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('::1'), true);
  assert.equal(isLoopbackHost('0.0.0.0'), false);
});
