import { loadReviewRuntimeConfig } from '@orvex-review/config';
import type { ReviewPromptFile, SourceChunk } from './contracts.js';
import { promptData, promptLabel } from './fencing.js';

const config = loadReviewRuntimeConfig();
const MAX_DIFF_CHARS = config.promptDiffChars;
const MAX_CHANGED_CHARS = config.promptChangedChars;
const FULL_CHANGED_FILE_CHARS = config.promptFullChangedFileChars;
const CHANGED_CONTEXT_LINES = config.promptChangedContextLines;
const MAX_CHANGED_CHUNK_CHARS = config.promptChangedChunkChars;

interface ChangedHunk {
  start: number;
  end: number;
}
interface SourceRange extends ChangedHunk {
  focusStart: number;
  focusEnd: number;
}

export function fairPromptBudgets(lengths: readonly number[], totalBudget: number): number[] {
  const budgets = lengths.map(() => 0);
  let remaining = totalBudget;
  let pending = lengths.map((_, index) => index).filter((index) => lengths[index]! > 0);
  while (remaining > 0 && pending.length > 0) {
    const share = Math.max(1, Math.floor(remaining / pending.length));
    let progressed = false;
    for (const index of pending) {
      if (remaining <= 0) break;
      const granted = Math.min(lengths[index]! - budgets[index]!, share, remaining);
      if (granted > 0) {
        budgets[index]! += granted;
        remaining -= granted;
        progressed = true;
      }
    }
    pending = pending.filter((index) => budgets[index]! < lengths[index]!);
    if (!progressed) break;
  }
  return budgets;
}

function sampleSection(section: string, budget: number): string {
  if (section.length <= budget) return section;
  const marker = `\n... [${section.length - budget} diff chars omitted; sampled start and end] ...\n`;
  if (budget <= marker.length + 2) return marker.slice(0, budget);
  const contentBudget = budget - marker.length;
  return `${section.slice(0, Math.ceil(contentBudget / 2))}${marker}${section.slice(-Math.floor(contentBudget / 2))}`;
}

function sampleDiff(patch: string, budget: number): string {
  if (patch.length <= budget) return patch;
  const sections = patch.split(/(?=^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@)/m);
  if (sections.length <= 1) return sampleSection(patch, budget);
  const budgets = fairPromptBudgets(
    sections.map((section) => section.length),
    budget,
  );
  return sections.map((section, index) => sampleSection(section, budgets[index]!)).join('');
}

export function buildDiffSections(files: readonly ReviewPromptFile[]): string[] {
  const patches = files.map((file) => promptData(file.patch ?? '(no patch — binary or too large)'));
  const budgets = fairPromptBudgets(
    patches.map((patch) => patch.length),
    MAX_DIFF_CHARS,
  );
  return files.map(
    (file, index) =>
      `### ${promptLabel(file.filename)} (${promptLabel(file.status)})\n\`\`\`diff\n${sampleDiff(patches[index]!, budgets[index]!)}\n\`\`\``,
  );
}

function changedHunks(patch: string | undefined): ChangedHunk[] {
  if (!patch) return [];
  const hunks: ChangedHunk[] = [];
  for (const line of patch.split('\n')) {
    const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!match) continue;
    const start = Math.max(1, Number(match[1]));
    hunks.push({ start, end: start + Math.max(1, Number(match[2] ?? 1)) - 1 });
  }
  return hunks;
}

function clipRange(lines: string[], range: SourceRange, maxChars: number) {
  const cumulative = new Array<number>(lines.length + 1);
  cumulative[0] = 0;
  for (let index = 0; index < lines.length; index++)
    cumulative[index + 1] = cumulative[index]! + lines[index]!.length + 1;
  const length = (start: number, end: number) =>
    end < start ? 0 : Math.max(0, cumulative[end]! - cumulative[start - 1]! - 1);
  if (length(range.start, range.end) <= maxChars)
    return {
      start: range.start,
      end: range.end,
      clippedBefore: false,
      clippedAfter: false,
      focusTruncated: false,
    };

  let start = Math.max(range.start, range.focusStart);
  let end = Math.min(range.end, range.focusEnd);
  let focusTruncated = false;
  if (length(start, end) > maxChars) {
    let low = start;
    let high = end;
    while (low < high) {
      const midpoint = Math.floor((low + high + 1) / 2);
      if (length(start, midpoint) <= maxChars) low = midpoint;
      else high = midpoint - 1;
    }
    end = low;
    focusTruncated = true;
  } else {
    let grew = true;
    while (grew) {
      grew = false;
      if (start > range.start && length(start - 1, end) <= maxChars) {
        start--;
        grew = true;
      }
      if (end < range.end && length(start, end + 1) <= maxChars) {
        end++;
        grew = true;
      }
    }
  }
  return {
    start,
    end,
    clippedBefore: start > range.start,
    clippedAfter: end < range.end,
    focusTruncated,
  };
}

function renderSourceChunk(lines: string[], range: SourceRange, maxChars: number): SourceChunk {
  const clip = clipRange(lines, range, maxChars);
  const body = lines.slice(clip.start - 1, clip.end).join('\n');
  const before = clip.clippedBefore ? '… [context clipped before]\n' : '';
  const after = clip.clippedAfter
    ? `\n… [${clip.focusTruncated ? 'CHANGED LINES TRUNCATED — this hunk continues past the budget' : 'context clipped after'}]`
    : '';
  return { start: clip.start, end: clip.end, content: `${before}${body}${after}` };
}

/** Build source windows around every changed hunk without silently losing one. */
export function chunkChangedFileContext(
  content: string,
  patch: string | undefined,
  maxChunkChars = MAX_CHANGED_CHUNK_CHARS,
): SourceChunk[] {
  const lines = content.split('\n');
  if (content.length <= Math.min(FULL_CHANGED_FILE_CHARS, maxChunkChars))
    return [{ start: 1, end: lines.length, content }];
  const ranges = changedHunks(patch)
    .map((hunk) => ({
      start: Math.max(1, hunk.start - CHANGED_CONTEXT_LINES),
      end: Math.min(lines.length, hunk.end + CHANGED_CONTEXT_LINES),
      focusStart: hunk.start,
      focusEnd: hunk.end,
    }))
    .sort((left, right) => left.start - right.start);
  if (ranges.length === 0) {
    const end = Math.min(lines.length, Math.max(1, CHANGED_CONTEXT_LINES * 2));
    return [
      renderSourceChunk(lines, { start: 1, end, focusStart: 1, focusEnd: end }, maxChunkChars),
    ];
  }
  const merged: SourceRange[] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end + 1) {
      const candidate = {
        start: previous.start,
        end: Math.max(previous.end, range.end),
        focusStart: Math.min(previous.focusStart, range.focusStart),
        focusEnd: Math.max(previous.focusEnd, range.focusEnd),
      };
      if (lines.slice(candidate.start - 1, candidate.end).join('\n').length <= maxChunkChars) {
        merged[merged.length - 1] = candidate;
        continue;
      }
    }
    merged.push(range);
  }
  return merged.map((range) => renderSourceChunk(lines, range, maxChunkChars));
}

export function appendChangedSourceContext(
  parts: string[],
  files: readonly ReviewPromptFile[],
  changedContents: Array<{ path: string; content: string }> | undefined,
  omittedChangedContents: readonly string[] | undefined,
): void {
  if (!changedContents?.length && !omittedChangedContents?.length) return;
  parts.push(
    '',
    '## Focused source context for changed hunks',
    'The diff above is the primary review target. These snippets add nearby control flow,',
    'guards, and error handling; do not assume code omitted from a large file is safe or unsafe.',
  );
  const omitted = new Set(
    (omittedChangedContents ?? []).map(
      (file) => `${promptLabel(file)} (no source shown — retrieval budget exhausted)`,
    ),
  );
  const entries =
    changedContents?.map((file) => {
      const patch = files.find((changed) => changed.filename === file.path)?.patch;
      return {
        file,
        patch,
        chunks: chunkChangedFileContext(file.content, patch),
        totalLines: file.content.split('\n').length,
      };
    }) ?? [];
  const candidates = entries.flatMap((entry, entryIndex) =>
    entry.chunks.map((chunk, chunkIndex) => ({ entryIndex, chunkIndex, chunk })),
  );
  const budgets = fairPromptBudgets(
    candidates.map(({ chunk }) => chunk.content.length + 180),
    MAX_CHANGED_CHARS,
  );
  const rendered = entries.map((entry) =>
    chunkChangedFileContext(
      entry.file.content,
      entry.patch,
      Math.max(96, Math.floor(MAX_CHANGED_CHARS / Math.max(1, candidates.length)) - 180),
    ),
  );
  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index]!;
    const entry = entries[candidate.entryIndex]!;
    const chunk = rendered[candidate.entryIndex]?.[candidate.chunkIndex] ?? candidate.chunk;
    const label =
      entry.chunks.length === 1 && chunk.start === 1 && chunk.end === entry.totalLines
        ? 'full file'
        : `lines ${chunk.start}-${chunk.end} of ${entry.totalLines} — around changed hunk`;
    const block = `\n### ${promptLabel(entry.file.path)} (${label})\n\`\`\`\n${promptData(chunk.content)}\n\`\`\``;
    if (block.length > budgets[index]!) {
      omitted.add(`${promptLabel(entry.file.path)} (${label}; source budget exhausted)`);
      continue;
    }
    parts.push(block);
  }
  if (omitted.size > 0) {
    parts.push(
      '',
      `⚠ Source context was NOT included for ${omitted.size} item(s) below. Their diffs ARE above.`,
      'Do NOT report that code is missing, unguarded, or uncleaned in these — you have not seen them:',
      ...Array.from(omitted, (item) => `  - ${item}`),
    );
  }
}
