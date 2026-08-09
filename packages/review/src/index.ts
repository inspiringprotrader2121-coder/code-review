export type { Finding, LlmReviewResponse, ReviewableFile } from './types.js';
export { FindingSchema, LlmReviewResponseSchema } from './types.js';
export { redactSecrets, redactPatch } from './redact.js';
export { loadOrvexRules, buildUserPrompt, fileRulesFor, type ReviewPromptContext } from './prompt.js';
export {
  runLlmReview,
  llmFindingsToReviewFindings,
  formatReviewComment,
  isTransientLlmError,
  REVIEW_INCOMPLETE_SUMMARY,
  type LlmReviewOptions,
} from './llm.js';
export {
  runCodexCliReview,
  closeCodexSession,
  isCodexRepoAllowed,
  killAllCodexChildren,
  setCodexChildListener,
  buildCodexPrompt,
  capCodexDiffFiles,
  trimCodexPrompt,
  CountingSemaphore,
  detectCodexAuthMode,
  assertCodexRuntimeReady,
  resolveCodexBinary,
  clearCodexAuthModeCache,
  resolveCodexHomeConcurrency,
  resolveCodexRateLimitPolicy,
  DEFAULT_CODEX_CLI_MODEL,
  DEFAULT_CODEX_CLI_REASONING_EFFORT,
  type CodexAuthMode,
  type CodexCliReviewOptions,
  type CodexCliReviewResult,
  type CodexChildListener,
  type CodexPromptMode,
} from './codex-cli.js';
export {
  type ReviewFinding,
  type ReviewSurfaceFinding,
  type FindingProvenance,
  fingerprintFinding,
  normalizeMessage,
  findingId,
  findingProvenance,
  tagFindingProvenance,
  mergeFindingProvenance,
} from './finding.js';
export {
  mergeFindings,
  toStoredFinding,
  reconcileFixedOnHead,
  verifyFindingOnHead,
  type FileReader,
  type MergeResult,
} from './merge.js';
export {
  collapseSameDefect,
  dedupeByFileLine,
  filterAndCapFindings,
  hasConcreteFailurePath,
} from './filter.js';
export {
  extractSymbols,
  extractTerms,
  isStrongSymbol,
  sameDefectText,
  type DefectMatch,
} from './similarity.js';
export {
  formatReviewBody,
  formatFixedReply,
  formatInlineFinding,
  formatFixAppliedReply,
  formatFixSkippedReply,
  formatFixSummaryComment,
  formatAutoApplyReply,
  formatHelpComment,
  formatReviewCommandsFooter,
  formatCommandsMarkdownTable,
  formatUsageNotesMarkdown,
  formatCommandsHtmlRows,
  orvexCommandCatalog,
  applyMarker,
  parseApplyMarker,
  applyCheckboxChecked,
  applyCheckboxLine,
  applyingLine,
  appliedLine,
  failedApplyLine,
  replaceApplyLine,
  type ReviewCommentMeta,
  type InlineFindingRender,
  type FixSummaryInput,
  sanitizeFileCell,
  sanitizeFindingText,
} from './format.js';
export { parseOrvexCommand, commandTrigger, type OrvexCommand } from './commands.js';
export type { OrvexCommandDoc, CommandWhere } from './commands-catalog.js';

export { applyFixToContent, type CodeFix, type ApplyResult } from './apply.js';
export {
  generateFixWithLlm,
  generateExplanationWithLlm,
  FixGenerationError,
  type GenerateFixInput,
  type GenerateFixOptions,
  type ExplainInput,
  type FixGenerationFailureKind,
} from './llm-fix.js';
export { runAgent, type AgentFile, type AgentOptions, type AgentResponse } from './agent.js';
export {
  runInvestigateReview,
  resolveUnderRoot,
  isSafeGrepPattern,
  extractDeletedSymbols,
  type InvestigateOptions,
} from './investigate.js';
export {
  verifyFindings,
  verifyFixes,
  isProtectedSourceTier,
  isWeakVerifierTier,
  shouldRescueHedgedRejection,
  partitionVerifiedFindings,
  parsePositiveIntEnv,
  applyVerdicts,
  type VerifierOptions,
  type VerifiedFindings,
  type VerificationStatus,
  type VerificationDisposition,
  type FixCandidate,
} from './verifier.js';
export { dropSelfNegatingFindings } from './noise.js';
export {
  summarizeModelContribution,
  formatModelContribution,
  type ModelContributionReport,
  type ModelContributionRow,
} from './contribution.js';
export { checkImportBindings, enumerateExports, extractNamedImports } from './import-check.js';
export {
  ReviewCancelledError,
  isReviewCancelledError,
  isRateLimitOrQuotaError,
  isOversizedModelRequest,
  llmChat,
  configureLlmProviderCoordinator,
  getProviderCooldownMs,
  providerBucketForTarget,
  setProviderCooldown,
  waitForProviderAvailability,
  withProviderCallSlot,
  type LlmClientOptions,
  type LlmAttemptEvent,
  type LlmAttemptOutcome,
  type LlmProviderCoordinator,
} from './llm-client.js';
export {
  aggregateRepeatedFindings,
  fitReviewAggregationToBudget,
  readReviewAggregationConfig,
  type EffectiveReviewAggregation,
  type RepeatedFinding,
  type RepeatedFindingAggregation,
  type ReviewAggregationConfig,
} from './aggregation.js';
export { DEEP_DIVE_FOCUS, THIRD_ANGLE_FOCUS, REMOVED_BEHAVIOR_FOCUS, RISK_HUNT_FOCUS } from './lenses.js';
export {
  maxRiskProbes,
  selectRiskProbes,
  isLargePr,
  hasDeleteOrRename,
  buildReviewPassAngles,
  type PassAngle,
} from './pass-budget.js';
export {
  detectRiskSignals,
  isHighRiskDiff,
  riskProbeFocus,
  type RiskDiffFile,
  type RiskSignal,
} from './risk.js';
export { isHedgedRejection } from './verifier.js';
