import type { ReviewPromptContext, ReviewPromptFile } from './contracts.js';
import { fileRulesFor } from './rules.js';

/**
 * The diff/context prefix is stable across review passes. Rules remain inside
 * that prefix; only the selected pass angle varies at the end for provider cache reuse.
 */
export function appendPassAngle(
  parts: string[],
  files: readonly ReviewPromptFile[],
  context?: ReviewPromptContext,
): void {
  const fileRules = fileRulesFor(files.map((file) => file.filename));
  if (fileRules) {
    parts.push(
      '',
      '## Rules for the file types in this change',
      '',
      'These apply IN ADDITION to the general rules — they are included because',
      'this diff touches files of these kinds.',
      '',
      fileRules,
    );
  }
  if (context?.extraFocus) parts.push('', context.extraFocus);
}
