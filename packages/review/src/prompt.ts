import type { ReviewPromptContext, ReviewPromptFile, SourceChunk } from './prompt/contracts.js';
import { appendChangedSourceContext, buildDiffSections } from './prompt/diff-context.js';
import { taskPreamble } from './prompt/fencing.js';
import { appendPassAngle } from './prompt/pass-angle.js';
import { appendRelatedContext } from './prompt/related-context.js';

export { type ReviewPromptContext } from './prompt/contracts.js';
export { chunkChangedFileContext } from './prompt/diff-context.js';
export { fileRulesFor, loadOrvexRules, REQUIRED_RULE_ANCHORS } from './prompt/rules.js';

/**
 * Stable public prompt entry point. The internal builders deliberately preserve
 * the order: fenced task framing, diff-first evidence, bounded source/context,
 * stable file rules, then the per-pass angle.
 */
export function buildUserPrompt(files: ReviewPromptFile[], context?: ReviewPromptContext): string {
  const parts = taskPreamble();
  parts.push('', ...buildDiffSections(files, context?.diffBudgetChars));
  appendChangedSourceContext(
    parts,
    files,
    context?.changedContents,
    context?.omittedChangedContents,
  );
  if (context) appendRelatedContext(parts, context);
  appendPassAngle(parts, files, context);
  return parts.join('\n');
}

export type { SourceChunk };
