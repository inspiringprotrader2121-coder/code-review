import { currentEnvironment } from '@orvex-review/config';
import path from 'node:path';
import {
  createCodexContainerRuntime,
  DEFAULT_SANDBOX_RUNTIME_OPTIONS,
  type SandboxRuntimeOptions,
} from './sandbox.js';
import {
  createRuntimeVerifyDependencies,
  DEFAULT_RUNTIME_VERIFY_LIMITS,
  type RuntimeVerifyDependencies,
  type RuntimeVerifyLimits,
} from './runtime-verify.js';
import type { CodexContainerRuntime } from '@orvex-review/review';

const MAX_SANDBOX_DISK_BYTES = 2 * 1024 * 1024 * 1024;

function optionalExact(value: string | undefined): string | undefined {
  return value && value.trim() === value ? value : undefined;
}

function optionalAbsolutePath(value: string | undefined): string | undefined {
  const exact = optionalExact(value);
  return exact && path.isAbsolute(exact) ? exact : undefined;
}

function boundedPositive(value: string | undefined, fallback: number, max: number): number {
  const parsed = value === undefined || value.trim() === '' ? fallback : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(Math.floor(parsed), max) : fallback;
}

/** Compatibility loader for the existing environment contract. */
export function loadSandboxRuntimeOptions(
  env: Readonly<NodeJS.ProcessEnv> = currentEnvironment(),
): SandboxRuntimeOptions {
  return Object.freeze({
    codeExecutionEnabled: env.ORVEX_CODE_EXECUTION === '1',
    codexContainerEnabled: env.ORVEX_CODEX_CONTAINER_RUNTIME === '1',
    image: optionalExact(env.ORVEX_SANDBOX_IMAGE),
    codexEgressBrokerImage: optionalExact(env.ORVEX_CODEX_EGRESS_BROKER_IMAGE),
    dockerHost: optionalExact(env.DOCKER_HOST),
    dockerContext: optionalExact(env.DOCKER_CONTEXT),
    maxConcurrentSandboxes: boundedPositive(
      env.ORVEX_MAX_SANDBOXES,
      DEFAULT_SANDBOX_RUNTIME_OPTIONS.maxConcurrentSandboxes,
      10_000,
    ),
    slotWaitMs: boundedPositive(
      env.ORVEX_SANDBOX_SLOT_WAIT_MS,
      DEFAULT_SANDBOX_RUNTIME_OPTIONS.slotWaitMs,
      3_600_000,
    ),
    slotDirectory: optionalAbsolutePath(env.ORVEX_SANDBOX_SLOT_DIR),
    slotStaleMs: boundedPositive(
      env.ORVEX_SANDBOX_SLOT_STALE_MS,
      DEFAULT_SANDBOX_RUNTIME_OPTIONS.slotStaleMs,
      3_600_000,
    ),
    workdirMaxBytes: boundedPositive(
      env.ORVEX_SANDBOX_WORKDIR_MAX_BYTES,
      DEFAULT_SANDBOX_RUNTIME_OPTIONS.workdirMaxBytes,
      MAX_SANDBOX_DISK_BYTES,
    ),
  });
}

export function loadRuntimeVerifyLimits(
  env: Readonly<NodeJS.ProcessEnv> = currentEnvironment(),
): RuntimeVerifyLimits {
  return Object.freeze({
    stepTimeoutMs: boundedPositive(
      env.ORVEX_SANDBOX_STEP_TIMEOUT_MS,
      DEFAULT_RUNTIME_VERIFY_LIMITS.stepTimeoutMs,
      900_000,
    ),
    installTimeoutMs: boundedPositive(
      env.ORVEX_SANDBOX_INSTALL_TIMEOUT_MS,
      DEFAULT_RUNTIME_VERIFY_LIMITS.installTimeoutMs,
      900_000,
    ),
    maxSnapshotFiles: DEFAULT_RUNTIME_VERIFY_LIMITS.maxSnapshotFiles,
  });
}

export interface SandboxRuntimeBindings {
  readonly sandbox: SandboxRuntimeOptions;
  readonly runtimeVerify: RuntimeVerifyDependencies;
  readonly codexContainer: CodexContainerRuntime;
}

/**
 * Composition seam: create one immutable snapshot and inject these bindings
 * into startup cleanup, runtime verification, and the Codex container adapter.
 */
export function createSandboxRuntimeBindings(
  env: Readonly<NodeJS.ProcessEnv> = currentEnvironment(),
): SandboxRuntimeBindings {
  const sandbox = loadSandboxRuntimeOptions(env);
  return Object.freeze({
    sandbox,
    runtimeVerify: createRuntimeVerifyDependencies(sandbox, loadRuntimeVerifyLimits(env)),
    codexContainer: Object.freeze(createCodexContainerRuntime(sandbox)),
  });
}
