/**
 * Keep untrusted repository/model text inside a markdown code block.
 * Collapsing runs of three or more backticks prevents the text from closing
 * the surrounding fence and turning the remainder of the prompt into
 * instruction-shaped markdown.
 */
export function safePromptData(value: string): string {
  return value.replace(/`{3,}/g, '``');
}
