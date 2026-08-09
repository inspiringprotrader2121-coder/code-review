// Stable public formatting facade. Keep imports from this module compatible as
// formatter internals evolve behind focused output-specific modules.
export { formatReviewBody } from './format/review-body.js';
export {
  applyMarker,
  APPLY_LINE_RE,
  applyCheckboxLine,
  applyingLine,
  appliedLine,
  failedApplyLine,
  replaceApplyLine,
  parseApplyMarker,
  applyCheckboxChecked,
} from './format/apply-markers.js';
export { formatInlineFinding } from './format/inline-finding.js';
export {
  formatFixedReply,
  formatFixAppliedReply,
  formatFixSkippedReply,
  formatFixSummaryComment,
  formatAutoApplyReply,
} from './format/fix-replies.js';
export { sanitizeFileCell, sanitizeFindingText } from './format/sanitize.js';
export type {
  ReviewCommentMeta,
  InlineFindingRender,
  FixSummaryInput,
} from './format/contracts.js';

export {
  formatHelpComment,
  formatReviewCommandsFooter,
  formatCommandsMarkdownTable,
  formatUsageNotesMarkdown,
  formatCommandsHtmlRows,
  orvexCommandCatalog,
  whereLabel,
  type OrvexCommandDoc,
  type CommandWhere,
} from './commands-catalog.js';
