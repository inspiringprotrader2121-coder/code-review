/**
 * Compatibility facade for the review LLM client.
 *
 * The implementation is deliberately split by operational concern in `./llm/`:
 * admission, retry policy, request lifecycle, provider transports, and parsing.
 * Keep imports here stable for existing callers while new internals stay cohesive.
 */
export { ReviewCancelledError, isReviewCancelledError } from './llm/cancellation.js';
export {
  configureLlmProviderCoordinator,
  commitProviderTpm,
  getProviderCooldownMs,
  getProviderLoad,
  isProviderAdmissionError,
  isProviderCapacityError,
  shouldRequeueAdmissionFailure,
  ADMISSION_JOB_REQUEUE_CAP,
  providerBucketForTarget,
  providerConcurrency,
  providerKeyLane,
  resetLocalProviderTpm,
  clearLocalProviderCooldown,
  runWithProviderAdmissionPriority,
  selectProviderKey,
  setProviderCooldown,
  splitApiKeys,
  tryReserveProviderTpm,
  waitForProviderAvailability,
  waitToReserveProviderTpm,
  withProviderCallSlot,
} from './llm/provider-admission.js';
export {
  isOversizedModelRequest,
  isRateLimitOrQuotaError,
  isRetryableEmptyProviderResponse,
  isRetryableRateLimit,
  isTpmWindowError,
  parseRetryAfterMs,
  rateLimitRetryWaitMs,
} from './llm/retry-policy.js';
export { llmChat } from './llm/client.js';
export { estimateTokens, resolveMaxOutputTokens } from './llm/support.js';
export {
  extractJsonLoose,
  jsonContractMissing,
  jsonFinishPrefix,
  JsonContractMismatchError,
  classifyStructuredOutput,
  isTruncationStopReason,
  stripThinking,
} from './llm/parsing.js';
export type {
  JsonContractKey,
  StructuredFailureClass,
  StructuredOutputClassification,
  StructuredRecoveryMode,
} from './llm/parsing.js';
export {
  recoverStructuredFinal,
  wrapStructuredFinalRepairUser,
  structuredFinalRepairInstruction,
  MAX_STRUCTURED_FINAL_REPAIR_ATTEMPTS,
} from './llm/structured-final.js';
export type {
  LlmAttemptEvent,
  LlmAttemptOutcome,
  LlmClientDependencies,
  LlmClientOptions,
  LlmProviderCoordinator,
} from './llm/contracts.js';
