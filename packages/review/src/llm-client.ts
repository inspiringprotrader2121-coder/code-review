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
  runWithProviderAdmissionPriority,
  selectProviderKey,
  setProviderCooldown,
  splitApiKeys,
  tryReserveProviderTpm,
  waitForProviderAvailability,
  withProviderCallSlot,
} from './llm/provider-admission.js';
export {
  isOversizedModelRequest,
  isRateLimitOrQuotaError,
  isRetryableEmptyProviderResponse,
  isRetryableRateLimit,
  parseRetryAfterMs,
} from './llm/retry-policy.js';
export { llmChat } from './llm/client.js';
export { estimateTokens, resolveMaxOutputTokens } from './llm/support.js';
export {
  extractJsonLoose,
  jsonContractMissing,
  jsonFinishPrefix,
  stripThinking,
} from './llm/parsing.js';
export type {
  LlmAttemptEvent,
  LlmAttemptOutcome,
  LlmClientDependencies,
  LlmClientOptions,
  LlmProviderCoordinator,
} from './llm/contracts.js';
