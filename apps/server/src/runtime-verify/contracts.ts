import type { fetchRepoSnapshot } from '@orvex-review/github';
import type { runInSandbox, SandboxRuntimeReadiness } from '../sandbox.js';

export interface RuntimeStep {
  name: string;
  command: string;
  ok: boolean;
  timedOut: boolean;
  durationMs: number;
  output: string;
  /** True when the same step also fails at the base commit. */
  preExisting?: boolean;
}

export interface RuntimeVerifyResult {
  ran: boolean;
  skippedReason?: string;
  steps: RuntimeStep[];
  /** Same steps at the base commit, when comparison was possible. */
  baseSteps?: RuntimeStep[];
}

/**
 * Explicit runtime boundary for a review verification. Production binds this
 * once from the immutable bootstrap snapshot; tests can replace individual
 * I/O operations without weakening the production defaults.
 */
export interface RuntimeVerifyDependencies {
  readonly fetchSnapshot: typeof fetchRepoSnapshot;
  readonly runSandbox: (
    options: Parameters<typeof runInSandbox>[0],
  ) => ReturnType<typeof runInSandbox>;
  readonly checkSandboxRuntimeReadiness: (signal?: AbortSignal) => Promise<SandboxRuntimeReadiness>;
  readonly stepTimeoutMs: number;
  readonly installTimeoutMs: number;
  readonly maxSnapshotFiles: number;
  readonly workdirMaxBytes: number;
}

export interface RuntimeVerifyOptions {
  baseSha?: string;
  /** Owning review cancellation signal, forwarded to every sandbox run. */
  signal?: AbortSignal;
  /** Test seam for lifecycle coverage without Docker or GitHub calls. */
  dependencies?: Partial<RuntimeVerifyDependencies>;
}

export interface RuntimeVerifyLimits {
  readonly stepTimeoutMs: number;
  readonly installTimeoutMs: number;
  readonly maxSnapshotFiles: number;
}

export const DEFAULT_RUNTIME_VERIFY_LIMITS: RuntimeVerifyLimits = Object.freeze({
  stepTimeoutMs: 240_000,
  installTimeoutMs: 300_000,
  maxSnapshotFiles: 20_000,
});
