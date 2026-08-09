/**
 * Keep untrusted repository/model text inside a markdown code block.
 * Collapsing runs of three or more backticks prevents the text from closing
 * the surrounding fence and turning the remainder of the prompt into
 * instruction-shaped markdown.
 */
export function safePromptData(value: string): string {
  return value.replace(/`{3,}/g, '``');
}

/** Render an untrusted filename/status as one inert line outside a code fence.
 * Git permits control characters such as newlines in paths; allowing those in
 * headings or omission lists lets repository data become instruction-shaped. */
export function safePromptLabel(value: string): string {
  return safePromptData(value)
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .trim();
}
