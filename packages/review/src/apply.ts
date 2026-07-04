export interface CodeFix {
  /** exact snippet expected to exist in the file right now */
  originalCode: string;
  /** replacement snippet */
  fixedCode: string;
  /** 1-indexed line hint used to disambiguate repeated snippets */
  line?: number;
}

export type ApplyResult =
  | { ok: true; content: string }
  | { ok: false; reason: 'not_found' | 'ambiguous' | 'noop' };

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let pos = haystack.indexOf(needle);
  while (pos !== -1) {
    count++;
    pos = haystack.indexOf(needle, pos + 1);
  }
  return count;
}

function lineOfIndex(content: string, index: number): number {
  return content.slice(0, index).split('\n').length;
}

/**
 * Replace `originalCode` with `fixedCode` in `content` — only when the anchor
 * is unambiguous. This is the safety core of auto-fix: if the code the finding
 * pointed at no longer exists (someone edited it since the review), we refuse
 * instead of guessing.
 */
export function applyFixToContent(content: string, fix: CodeFix): ApplyResult {
  const original = fix.originalCode;
  if (!original || fix.fixedCode === undefined) return { ok: false, reason: 'not_found' };
  if (original === fix.fixedCode) return { ok: false, reason: 'noop' };

  let occurrences = countOccurrences(content, original);
  let needle = original;

  // tolerate trailing-whitespace drift on single-line anchors
  if (occurrences === 0 && !original.includes('\n')) {
    const trimmed = original.trimEnd();
    if (trimmed && trimmed !== original) {
      needle = trimmed;
      occurrences = countOccurrences(content, trimmed);
    }
  }

  if (occurrences === 0) return { ok: false, reason: 'not_found' };

  if (occurrences === 1) {
    return { ok: true, content: content.replace(needle, () => fix.fixedCode) };
  }

  // multiple matches: use the line hint to pick the right one
  if (!fix.line) return { ok: false, reason: 'ambiguous' };
  let pos = content.indexOf(needle);
  let best: { index: number; distance: number } | null = null;
  while (pos !== -1) {
    const startLine = lineOfIndex(content, pos);
    const endLine = startLine + needle.split('\n').length - 1;
    const distance =
      fix.line >= startLine && fix.line <= endLine
        ? 0
        : Math.min(Math.abs(fix.line - startLine), Math.abs(fix.line - endLine));
    if (!best || distance < best.distance) best = { index: pos, distance };
    pos = content.indexOf(needle, pos + 1);
  }
  if (!best || best.distance > 3) return { ok: false, reason: 'ambiguous' };

  return {
    ok: true,
    content:
      content.slice(0, best.index) + fix.fixedCode + content.slice(best.index + needle.length),
  };
}
