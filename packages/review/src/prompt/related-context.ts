import { loadReviewRuntimeConfig } from '@orvex-review/config';
import type { ReviewPromptContext } from './contracts.js';
import { promptData, promptLabel } from './fencing.js';

const config = loadReviewRuntimeConfig();

function appendBoundedFiles(
  parts: string[],
  entries: readonly { path: string; content: string }[],
  omitted: readonly string[],
  budget: number,
  heading: string,
  render: (path: string, content: string) => string,
  omittedLine: (path: string) => string,
): void {
  let used = 0;
  const skipped = [...omitted.map(promptLabel)];
  for (const entry of entries) {
    const safePath = promptLabel(entry.path);
    const block = render(safePath, entry.content);
    if (used + block.length > budget) {
      skipped.push(safePath);
      continue;
    }
    parts.push(block);
    used += block.length;
  }
  if (skipped.length > 0) {
    parts.push('', heading, ...skipped.map(omittedLine));
  }
}

/** Append context only after the changed diff/source, and disclose every omission. */
export function appendRelatedContext(parts: string[], context: ReviewPromptContext): void {
  if (
    context.related?.length ||
    context.dependents?.length ||
    context.omittedRelated?.length ||
    context.omittedDependents?.length
  ) {
    parts.push(
      '',
      '## Cross-file context (CONTEXT ONLY — do not report issues in these files themselves)',
      'Imported files show callee contracts; dependent files show callers the diff may break.',
      'Only report findings whose *cause* is in the diff; anchor every finding to a changed file.',
    );
    let used = 0;
    const skippedRelated = [...(context.omittedRelated ?? []).map(promptLabel)];
    const skippedDependents = [...(context.omittedDependents ?? []).map(promptLabel)];
    for (const entry of context.related ?? []) {
      const path = promptLabel(entry.path);
      const block = `\n### ${path} (imported by changed code)\n\`\`\`\n${promptData(entry.content)}\n\`\`\``;
      if (used + block.length > config.promptRelatedChars) {
        skippedRelated.push(path);
        continue;
      }
      parts.push(block);
      used += block.length;
    }
    for (const entry of context.dependents ?? []) {
      const path = promptLabel(entry.path);
      const block = `\n### ${path} (imports the changed code — check for breakage)\n\`\`\`\n${promptData(entry.content)}\n\`\`\``;
      if (used + block.length > config.promptRelatedChars) {
        skippedDependents.push(path);
        continue;
      }
      parts.push(block);
      used += block.length;
    }
    if (skippedRelated.length || skippedDependents.length) {
      parts.push(
        '',
        'Cross-file coverage notice: these files were not included because the context budget was exhausted.',
        ...skippedRelated.map((path) => `  - related: ${path}`),
        ...skippedDependents.map((path) => `  - dependent: ${path}`),
      );
    }
  }

  if (context.others?.length || context.omittedOthers?.length) {
    parts.push(
      '',
      '## Rest of the repository (CONTEXT ONLY — do not report issues in these files)',
      'The remaining repo files, so you can check contracts, config, and conventions anywhere.',
    );
    appendBoundedFiles(
      parts,
      context.others ?? [],
      context.omittedOthers ?? [],
      config.promptOtherChars,
      'Repository-context coverage notice: these files were not included because the context budget was exhausted.',
      (path, content) => `\n### ${path}\n\`\`\`\n${promptData(content)}\n\`\`\``,
      (path) => `  - ${path}`,
    );
  }

  if (context.treePaths?.length) {
    const shown = context.treePaths.slice(0, config.promptTreePaths);
    parts.push(
      '',
      '## Repository structure (for orientation)',
      '```',
      promptData(shown.join('\n')),
      shown.length < context.treePaths.length
        ? `… ${context.treePaths.length - shown.length} more files`
        : '',
      '```',
    );
  }
}
