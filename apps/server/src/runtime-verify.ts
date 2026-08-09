/**
 * Stable facade for per-review runtime verification.
 *
 * The implementation is deliberately split by runtime-validation concern:
 * immutable dependency binding, hostile snapshot validation, sandboxed
 * execution, and publication-safe evidence formatting. Bootstrap owns the
 * broader environment/provider/store/queue readiness checks and injects the
 * resulting immutable sandbox bindings here.
 */
export {
  DEFAULT_RUNTIME_VERIFY_LIMITS,
  type RuntimeStep,
  type RuntimeVerifyDependencies,
  type RuntimeVerifyLimits,
  type RuntimeVerifyOptions,
  type RuntimeVerifyResult,
} from './runtime-verify/contracts.js';
export { createRuntimeVerifyDependencies } from './runtime-verify/dependencies.js';
export {
  cancelledRuntimeVerifyResult,
  markPreExistingFailures,
  runtimeVerify,
} from './runtime-verify/execution.js';
export { formatRuntimeEvidence, tailRuntimeOutput } from './runtime-verify/evidence.js';
