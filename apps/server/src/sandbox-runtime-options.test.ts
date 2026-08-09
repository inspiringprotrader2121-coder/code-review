import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createSandboxRuntimeBindings,
  loadRuntimeVerifyLimits,
  loadSandboxRuntimeOptions,
} from './sandbox-runtime-options.js';

const RUNTIME_IMAGE = `registry.example/orvex-runtime@sha256:${'a'.repeat(64)}`;
const BROKER_IMAGE = `registry.example/orvex-egress@sha256:${'b'.repeat(64)}`;

test('sandbox environment compatibility maps the existing names into one frozen snapshot', () => {
  const options = loadSandboxRuntimeOptions({
    ORVEX_CODE_EXECUTION: '1',
    ORVEX_CODEX_CONTAINER_RUNTIME: '1',
    ORVEX_SANDBOX_IMAGE: RUNTIME_IMAGE,
    ORVEX_CODEX_EGRESS_BROKER_IMAGE: BROKER_IMAGE,
    DOCKER_HOST: 'unix:///run/user/1000/docker.sock',
    ORVEX_MAX_SANDBOXES: '8',
    ORVEX_SANDBOX_SLOT_WAIT_MS: '45000',
    ORVEX_SANDBOX_WORKDIR_MAX_BYTES: '1073741824',
  });

  assert.equal(Object.isFrozen(options), true);
  assert.deepEqual(options, {
    codeExecutionEnabled: true,
    codexContainerEnabled: true,
    image: RUNTIME_IMAGE,
    codexEgressBrokerImage: BROKER_IMAGE,
    dockerHost: 'unix:///run/user/1000/docker.sock',
    dockerContext: undefined,
    maxConcurrentSandboxes: 8,
    slotWaitMs: 45_000,
    workdirMaxBytes: 1_073_741_824,
  });
});

test('sandbox compatibility loader preserves fail-closed defaults and numeric bounds', () => {
  const defaults = loadSandboxRuntimeOptions({});
  assert.equal(defaults.codeExecutionEnabled, false);
  assert.equal(defaults.codexContainerEnabled, false);
  assert.equal(defaults.image, undefined);
  assert.equal(defaults.maxConcurrentSandboxes, 2);
  assert.equal(defaults.slotWaitMs, 600_000);
  assert.equal(defaults.workdirMaxBytes, 4 * 1024 * 1024 * 1024);

  const bounded = loadSandboxRuntimeOptions({
    ORVEX_MAX_SANDBOXES: '999',
    ORVEX_SANDBOX_SLOT_WAIT_MS: '99999999',
    ORVEX_SANDBOX_WORKDIR_MAX_BYTES: '999999999999',
    ORVEX_SANDBOX_IMAGE: ` ${RUNTIME_IMAGE}`,
  });
  assert.equal(bounded.maxConcurrentSandboxes, 64);
  assert.equal(bounded.slotWaitMs, 3_600_000);
  assert.equal(bounded.workdirMaxBytes, 16 * 1024 * 1024 * 1024);
  assert.equal(bounded.image, undefined, 'whitespace-altered image references stay invalid');
});

test('runtime verification limits retain the existing environment contract and are immutable', () => {
  const limits = loadRuntimeVerifyLimits({
    ORVEX_SANDBOX_STEP_TIMEOUT_MS: '120000',
    ORVEX_SANDBOX_INSTALL_TIMEOUT_MS: '990000',
  });
  assert.equal(Object.isFrozen(limits), true);
  assert.deepEqual(limits, {
    stepTimeoutMs: 120_000,
    installTimeoutMs: 900_000,
    maxSnapshotFiles: 20_000,
  });
});

test('production factory binds runtime verification to the same immutable sandbox snapshot', async () => {
  const bindings = createSandboxRuntimeBindings({
    ORVEX_SANDBOX_WORKDIR_MAX_BYTES: '1234567',
    ORVEX_SANDBOX_STEP_TIMEOUT_MS: '222222',
  });
  assert.equal(Object.isFrozen(bindings), true);
  assert.equal(Object.isFrozen(bindings.sandbox), true);
  assert.equal(Object.isFrozen(bindings.runtimeVerify), true);
  assert.equal(Object.isFrozen(bindings.codexContainer), true);
  assert.equal(bindings.runtimeVerify.workdirMaxBytes, bindings.sandbox.workdirMaxBytes);
  assert.equal(bindings.runtimeVerify.stepTimeoutMs, 222_222);
  assert.deepEqual(await bindings.runtimeVerify.checkSandboxRuntimeReadiness(), {
    ready: false,
    reason: 'code execution is disabled',
  });
});
