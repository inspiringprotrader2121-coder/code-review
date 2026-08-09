import { fetchRepoSnapshot } from '@orvex-review/github';
import {
  checkSandboxRuntimeReadiness,
  DEFAULT_SANDBOX_RUNTIME_OPTIONS,
  runInSandbox,
  type SandboxRuntimeOptions,
} from '../sandbox.js';
import {
  DEFAULT_RUNTIME_VERIFY_LIMITS,
  type RuntimeVerifyDependencies,
  type RuntimeVerifyLimits,
} from './contracts.js';

/** Bind runtime verification to one immutable sandbox/config snapshot. */
export function createRuntimeVerifyDependencies(
  sandboxRuntime: SandboxRuntimeOptions,
  limits: RuntimeVerifyLimits = DEFAULT_RUNTIME_VERIFY_LIMITS,
  overrides: Partial<RuntimeVerifyDependencies> = {},
): RuntimeVerifyDependencies {
  return Object.freeze({
    fetchSnapshot: fetchRepoSnapshot,
    runSandbox: (options: Parameters<typeof runInSandbox>[0]) =>
      runInSandbox(options, sandboxRuntime),
    checkSandboxRuntimeReadiness: (signal?: AbortSignal) =>
      checkSandboxRuntimeReadiness({ runtime: sandboxRuntime, signal }),
    stepTimeoutMs: limits.stepTimeoutMs,
    installTimeoutMs: limits.installTimeoutMs,
    maxSnapshotFiles: limits.maxSnapshotFiles,
    workdirMaxBytes: sandboxRuntime.workdirMaxBytes,
    ...overrides,
  });
}

/** Local-safe defaults keep code execution disabled until configured at bootstrap. */
export const defaultRuntimeVerifyDependencies = createRuntimeVerifyDependencies(
  DEFAULT_SANDBOX_RUNTIME_OPTIONS,
);
