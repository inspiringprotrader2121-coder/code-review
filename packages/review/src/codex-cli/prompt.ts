import { loadReviewRuntimeConfig } from '@orvex-review/config';
import { buildUserPrompt, loadOrvexRules, type ReviewPromptContext } from '../prompt.js';
import { redactPatch, redactSecrets } from '../redact.js';
import type { ReviewableFile } from '../types.js';
import type { CodexPromptMode } from './contracts.js';

function configuredBudget(name: string, fallback: number): number {
  const config = loadReviewRuntimeConfig();
  switch (name) {
    case 'ORVEX_CODEX_SLIM_DIFF_CHARS':
      return config.codexSlimDiffChars;
    case 'ORVEX_CODEX_MAX_DIFF_CHARS':
      return config.codexMaxDiffChars;
    case 'ORVEX_CODEX_MAX_TREE_PATHS':
      return config.codexMaxTreePaths;
    case 'ORVEX_CODEX_SLIM_PROMPT_CHARS':
      return config.codexSlimPromptChars;
    case 'ORVEX_CODEX_MAX_PROMPT_CHARS':
      return config.codexMaxPromptChars;
    default:
      return fallback;
  }
}

export function capCodexDiffFiles<T extends { filename: string; status: string; patch?: string }>(
  files: readonly T[],
  maxChars: number,
): T[] {
  if (maxChars <= 0) {
    return files.map((file) => ({
      ...file,
      patch: `(diff omitted - read ${file.filename} from the checkout)`,
    }));
  }
  let used = 0;
  return files.map((file) => {
    const patch = file.patch ?? '';
    if (used >= maxChars) {
      return {
        ...file,
        patch: `(diff omitted - Codex prompt budget; read ${file.filename} from the checkout)`,
      };
    }
    const room = maxChars - used;
    if (patch.length <= room) {
      used += patch.length;
      return file;
    }
    used = maxChars;
    return {
      ...file,
      patch: `${patch.slice(0, Math.max(0, room - 80))}\n... [truncated ${patch.length - room} chars - read full file from checkout]`,
    };
  });
}

const LEAN_EXPLORE = [
  '## You are an agent - INVESTIGATE the repo, do not one-shot',
  'The complete repository is checked out at your CWD. Diffs below are a STARTING',
  'POINT only - source bodies were NOT pasted (read them from disk).',
  'Before you report:',
  '- `rg`/`grep` changed symbols for callers/callees and broken invariants.',
  '- Read changed files with `sed -n` / `head` ranges - NEVER dump a whole large file',
  '  into the conversation (that blows the context window and fails the review).',
  '- Trace data flow and nearby tests; confirm every finding at file:line.',
  '- Timebox the investigation to at most 12 shell/tool calls. Prioritize the diff,',
  '  direct call sites, and targeted noninteractive tests; do not run broad suites.',
  '- Finish and return the JSON before the worker wall-clock cap.',
  'Return JSON: { "findings": [...], "summary": "..." }.',
  '',
].join('\n');

const SLIM_EXPLORE = [
  '## Agentic review (slim context - prior turn was too large)',
  'The repo is at CWD. Use rg and bounded sed ranges only. Focus on concrete P1/P2 bugs.',
  'Use at most 8 shell/tool calls and return JSON before the wall-clock cap.',
  'Return JSON: { "findings": [...], "summary": "..." }.',
  '',
].join('\n');

export function trimCodexPrompt(prompt: string, maxChars: number): string {
  if (maxChars <= 0 || prompt.length <= maxChars) return prompt;
  const keep = Math.max(0, maxChars - 120);
  return `${prompt.slice(0, keep)}\n\n... [Codex prompt truncated ${prompt.length - keep} chars; explore the checkout for omitted context]\n`;
}

export function buildCodexPrompt(
  files: ReviewableFile[],
  context?: ReviewPromptContext,
  opts: { hasRepoCheckout?: boolean; mode?: CodexPromptMode } = {},
): string {
  const hasCheckout = Boolean(opts.hasRepoCheckout);
  const mode = opts.mode ?? (hasCheckout ? 'lean' : 'full');
  const maxDiffChars =
    mode === 'slim'
      ? configuredBudget('ORVEX_CODEX_SLIM_DIFF_CHARS', 30_000)
      : mode === 'lean'
        ? configuredBudget('ORVEX_CODEX_MAX_DIFF_CHARS', 60_000)
        : Number.POSITIVE_INFINITY;
  const redactedDiffs = files
    .filter((file) => file.patch && file.status !== 'removed')
    .map((file) => ({
      filename: file.filename,
      status: file.status,
      patch: redactPatch(file.patch!) ?? '',
    }));
  const diffBudget = Number.isFinite(maxDiffChars) ? maxDiffChars : 10_000_000;
  const completeDiff = context?.diffCoverage === 'require-complete';
  const completeDiffChars = redactedDiffs.reduce((sum, file) => sum + file.patch.length, 0);
  if (completeDiff && completeDiffChars > diffBudget) {
    throw new Error(
      `required complete Codex diff shard exceeds ${diffBudget}-character budget (${completeDiffChars} chars)`,
    );
  }
  const filesForPrompt = completeDiff
    ? redactedDiffs
    : capCodexDiffFiles(redactedDiffs, diffBudget);
  const redactAll = (items?: Array<{ path: string; content: string }>) =>
    items?.map((item) => ({ ...item, content: redactSecrets(item.content) }));
  const maxTree =
    mode === 'slim'
      ? 0
      : mode === 'lean'
        ? configuredBudget('ORVEX_CODEX_MAX_TREE_PATHS', 400)
        : undefined;
  const promptContext: ReviewPromptContext | undefined = context && {
    promptProfile: context.promptProfile,
    diffBudgetChars: context.diffBudgetChars,
    diffCoverage: context.diffCoverage,
    treePaths:
      maxTree === 0
        ? undefined
        : maxTree === undefined
          ? context.treePaths
          : context.treePaths?.slice(0, maxTree),
    related: hasCheckout || mode !== 'full' ? undefined : redactAll(context.related),
    dependents: hasCheckout || mode !== 'full' ? undefined : redactAll(context.dependents),
    changedContents:
      hasCheckout || mode !== 'full' ? undefined : redactAll(context.changedContents),
    others: hasCheckout || mode !== 'full' ? undefined : redactAll(context.others),
    extraFocus: context.extraFocus,
  };
  const user = buildUserPrompt(filesForPrompt, promptContext);
  if (mode === 'slim') {
    const promptBudget = configuredBudget('ORVEX_CODEX_SLIM_PROMPT_CHARS', 50_000);
    if (completeDiff && `${SLIM_EXPLORE}\n${user}`.length > promptBudget)
      throw new Error(`required complete Codex prompt exceeds ${promptBudget}-character budget`);
    return trimCodexPrompt(`${SLIM_EXPLORE}\n${user}`, promptBudget);
  }
  const system = loadOrvexRules();
  if (!hasCheckout && mode === 'full') return `${system}\n\n${user}`;
  const body = hasCheckout ? `${system}\n\n${LEAN_EXPLORE}\n${user}` : `${system}\n\n${user}`;
  const promptBudget = configuredBudget('ORVEX_CODEX_MAX_PROMPT_CHARS', 100_000);
  if (completeDiff && body.length > promptBudget)
    throw new Error(`required complete Codex prompt exceeds ${promptBudget}-character budget`);
  return trimCodexPrompt(body, promptBudget);
}
