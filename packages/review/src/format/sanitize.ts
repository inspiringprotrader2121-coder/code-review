/** Strip table/code-span delimiters from a Git path before rendering it. */
export function sanitizeFileCell(file: string): string {
  return file.replace(/[|`\r\n]/g, '');
}

/**
 * Defang markdown/HTML sequences which could turn model or repository text into
 * interactive controls, escape a collapsed section, or swallow later content.
 */
export function sanitizeFindingText(s: string | undefined): string {
  if (!s) return '';
  return s
    .replace(/<!--\s*orvex:apply:/gi, '<!-- orvex-apply-blocked:')
    .replace(/^(\s*>?\s*)(?:[-*+]|\d+\.)\s*\[( |x|X)\]/gm, '$1• [$2]')
    .replace(/<\s*\/\s*(details|summary)\s*>/gi, '&lt;/$1&gt;')
    .replace(/<\s*(details|summary)\b/gi, '&lt;$1')
    .replace(/<\s*(script|iframe|img|a|style|form|object|embed)\b/gi, '&lt;$1')
    .replace(/`{3,}/g, '``');
}

/** Close an attacker-opened Markdown code fence before emitting bot controls. */
export function closeOpenFences(parts: string[]): void {
  if ((parts.join('\n').match(/```/g) ?? []).length % 2 === 1) parts.push('```');
}
