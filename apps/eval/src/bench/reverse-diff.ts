/**
 * Reverse a unified-diff patch (GitHub's `file.patch` hunk format).
 *
 * The ground-truth reversion benchmark works by taking a real bug-FIX commit and
 * reversing its patch, so the *buggy* code appears as newly-added lines. Feeding
 * that reversed patch to the reviewer is "here is a PR that introduces the bug" —
 * a review that flags it is catching a real, human-confirmed bug. The fix's own
 * location is the objective ground truth (a maintainer changed exactly there).
 *
 * A GitHub file patch is hunks only (no `---/+++` file header):
 *   @@ -a,b +c,d @@ optional section heading
 *    context line
 *   -removed line
 *   +added line
 *
 * Reversing: swap the two side-ranges in each header, turn `-` into `+` and `+`
 * into `-`, leave context lines alone, and drop the section heading (it names the
 * enclosing symbol on the OLD side, which no longer applies once reversed).
 */
export interface ReversedHunkRange {
  /** 1-based first line, in the reversed patch's NEW file (= the buggy file), of
   *  the region the fix touched. This is where a real finding should land. */
  start: number;
  /** number of lines in that region (0 → a pure deletion point) */
  count: number;
}

export interface ReverseResult {
  patch: string;
  /** Line ranges (in the buggy file) the fix changed — the ground-truth target. */
  ranges: ReversedHunkRange[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function reversePatch(patch: string): ReverseResult {
  const out: string[] = [];
  const ranges: ReversedHunkRange[] = [];
  const lines = patch.split('\n');

  for (const line of lines) {
    const m = HUNK_RE.exec(line);
    if (m) {
      const oldStart = Number(m[1]);
      const oldCount = m[2] === undefined ? 1 : Number(m[2]);
      const newStart = Number(m[3]);
      const newCount = m[4] === undefined ? 1 : Number(m[4]);
      // Reversed header: the old side and new side swap. Drop the trailing
      // section heading (everything after the closing `@@`).
      out.push(`@@ -${newStart},${newCount} +${oldStart},${oldCount} @@`);
      // In the reversed patch, the buggy region is the ORIGINAL old side, now
      // living at oldStart with oldCount lines in the reversed NEW file.
      ranges.push({ start: oldStart, count: oldCount });
      continue;
    }
    if (line.startsWith('+')) out.push('-' + line.slice(1));
    else if (line.startsWith('-')) out.push('+' + line.slice(1));
    else out.push(line); // context, '\ No newline…', or blank
  }

  return { patch: out.join('\n'), ranges };
}
