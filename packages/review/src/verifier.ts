/**
 * Public verifier compatibility facade.
 *
 * The implementation is intentionally split by responsibility under
 * `verifier/`; import this module for the stable review-package API.
 */
export {
  type FixCandidate,
  type VerificationDisposition,
  type VerificationStatus,
  type VerifiedFindings,
  type VerifierOptions,
  type Verdicts,
} from './verifier/contracts.js';
export { partitionVerifiedFindings } from './verifier/disposition.js';
export { verifyFindings } from './verifier/execution.js';
export { verifyFixes } from './verifier/fixes.js';
export {
  isHedgedRejection,
  isProtectedSourceTier,
  isWeakVerifierTier,
  shouldRescueHedgedRejection,
} from './verifier/policy.js';
export { SEVERITY_INSTRUCTIONS } from './verifier/prompt.js';
export { buildVerifierFileBlocks, formatFindingProvenance } from './verifier/source.js';
export { applyVerdicts } from './verifier/verdicts.js';

/** Parse a positive finite configuration integer with a stable fallback. */
export function parsePositiveIntEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
