/**
 * Public investigate compatibility facade.
 *
 * The read-only tool-loop implementation is split by responsibility under
 * `investigate/`; import this module for the stable review-package API.
 */
export { runInvestigateTool } from './investigate/dispatcher.js';
export { runInvestigateReview, investigateThinkingEnabled } from './investigate/execution.js';
export { classifyInvestigateResponse } from './investigate/classify.js';
export { isSafeGlob, isSafeGrepPattern, resolveUnderRoot } from './investigate/policy.js';
export { extractDeletedSymbols } from './investigate/symbols.js';
export type { InvestigateOptions } from './investigate/contracts.js';
export type { ClassifiedInvestigateResponse } from './investigate/classify.js';
