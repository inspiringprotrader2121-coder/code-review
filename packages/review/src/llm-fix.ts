import { z } from 'zod';
import { llmChat, extractJsonLoose } from './llm-client.js';
import { redactSecrets } from './redact.js';
import type { CodeFix } from './apply.js';
import { safePromptData } from './prompt-safety.js';

const LlmFixSchema = z.object({
  originalCode: z.string().min(1),
  fixedCode: z.string(),
  explanation: z.string().optional(),
});

export interface GenerateFixInput {
  filePath: string;
  fileContent: string;
  findingMessage: string;
  findingLine?: number;
  suggestion?: string;
  /** free-form user instruction from `@orvex <prompt>` */
  instruction?: string;
  /** files imported by filePath — context so the fix respects cross-file contracts */
  relatedFiles?: Array<{ path: string; content: string }>;
}

export interface GenerateFixOptions {
  apiKey: string;
  model: string;
  /** OpenAI-compatible endpoint (e.g. MiniMax); omit to use Anthropic */
  baseUrl?: string;
  api?: 'chat' | 'responses' | 'anthropic';
  reasoningEffort?: string;
  onUsage?: (usage: {
    inputTokens: number;
    cachedInputTokens?: number;
    cacheWriteTokens?: number;
    outputTokens: number;
    tokenSource?: 'provider' | 'estimate';
    provider?: string;
    model?: string;
  }) => void;
}

const MAX_FILE_CHARS = 60_000;

export type FixGenerationFailureKind = 'transient' | 'unparseable' | 'no_fix';

export class FixGenerationError extends Error {
  constructor(
    message: string,
    public readonly kind: FixGenerationFailureKind,
  ) {
    super(message);
  }
}

/**
 * Ask the LLM for a search/replace fix for one finding. The returned
 * originalCode must exist verbatim in the file — the caller re-validates via
 * applyFixToContent, so a hallucinated anchor fails closed.
 */
export async function generateFixWithLlm(
  input: GenerateFixInput,
  opts: GenerateFixOptions,
): Promise<(CodeFix & { explanation?: string }) | null> {
  // file contents leave the box — redact secrets first. If a fix would target a
  // redacted line, its anchor won't match the real file and it fails closed.
  const windowed = truncateAroundLine(redactSecrets(input.fileContent), input.findingLine);
  const numbered = withLineNumbers(windowed.text, windowed.startLine);

  const task = input.instruction
    ? `Apply this instruction from the developer: ${input.instruction}`
    : `Fix this code-review finding: ${input.findingMessage}` +
      (input.suggestion ? `\nReviewer suggestion: ${input.suggestion}` : '');

  const related = (input.relatedFiles ?? [])
    .slice(0, 12)
    .map(
      (r) =>
        `### ${safePromptData(r.path)} (repo context only, do NOT edit)\n\`\`\`\n${safePromptData(redactSecrets(r.content.slice(0, 24_000)))}\n\`\`\``,
    )
    .join('\n');

  const user = [
    `File: ${safePromptData(input.filePath)}`,
    input.findingLine ? `Finding is anchored at line ${input.findingLine}.` : '',
    '',
    safePromptData(task),
    '',
    'File content (line numbers are for reference only, they are NOT part of the file):',
    '```',
    safePromptData(numbered),
    '```',
    related ? `\nCross-file context (respect these signatures and contracts):\n${related}\n` : '',
    'Respond with JSON only:',
    '{ "originalCode": "<exact contiguous snippet copied verbatim from the file, WITHOUT line numbers>",',
    '  "fixedCode": "<replacement snippet>",',
    '  "explanation": "<one sentence>" }',
    'Rules:',
    '- originalCode MUST appear verbatim in the file exactly once; keep it as small as possible.',
    '- Change only what the fix requires. No drive-by refactors.',
    '- If no safe fix is possible, respond {"originalCode": "", "fixedCode": ""}.',
  ].join('\n');

  let text: string;
  try {
    text = await llmChat(
      'You are Orvex Review, generating minimal, safe code fixes. You respond with strict JSON only.',
      user,
      {
        apiKey: opts.apiKey,
        model: opts.model,
        baseUrl: opts.baseUrl,
        api: opts.api,
        reasoningEffort: opts.reasoningEffort,
        json: true,
        onUsage: opts.onUsage,
      },
    );
  } catch (err) {
    throw new FixGenerationError((err as Error).message, 'transient');
  }

  let parsed: z.infer<typeof LlmFixSchema>;
  try {
    parsed = LlmFixSchema.parse(extractJsonLoose(text));
  } catch (err) {
    throw new FixGenerationError((err as Error).message, 'unparseable');
  }

  if (!parsed.originalCode || parsed.originalCode === parsed.fixedCode) {
    throw new FixGenerationError('no safe fix could be generated', 'no_fix');
  }

  return {
    originalCode: parsed.originalCode,
    fixedCode: parsed.fixedCode,
    line: input.findingLine,
    explanation: parsed.explanation,
  };
}

export interface ExplainInput {
  filePath: string;
  fileContent: string;
  findingMessage: string;
  findingLine?: number;
  suggestion?: string;
  severity?: string;
}

/** `@orvex explain` — a deeper walkthrough of one finding, posted as a thread reply. */
export async function generateExplanationWithLlm(
  input: ExplainInput,
  opts: GenerateFixOptions,
): Promise<string | null> {
  const windowed = truncateAroundLine(redactSecrets(input.fileContent), input.findingLine);
  const numbered = withLineNumbers(windowed.text, windowed.startLine);

  const user = [
    `File: ${input.filePath}`,
    input.findingLine ? `The finding is anchored at line ${input.findingLine}.` : '',
    `Severity: ${input.severity ?? 'unknown'}`,
    '',
    `Finding: ${input.findingMessage}`,
    input.suggestion ? `Suggested fix: ${input.suggestion}` : '',
    '',
    'File content (line numbers for reference only):',
    '```',
    numbered,
    '```',
    '',
    'Explain this finding for the PR author in GitHub markdown:',
    '1. What exactly is wrong (walk through the failure scenario with concrete inputs/state).',
    '2. Why it matters (impact, severity justification).',
    '3. How to fix it (short, concrete).',
    'Keep it under 250 words. No preamble, start directly with the explanation.',
  ].join('\n');

  try {
    const text = await llmChat(
      'You are Orvex Review, explaining a code-review finding clearly and concretely.',
      user,
      {
        apiKey: opts.apiKey,
        model: opts.model,
        baseUrl: opts.baseUrl,
        api: opts.api,
        reasoningEffort: opts.reasoningEffort,
        onUsage: opts.onUsage,
      },
    );
    return text.trim() || null;
  } catch {
    return null;
  }
}

function withLineNumbers(content: string, startLine: number): string {
  return content
    .split('\n')
    .map((l, i) => `${String(startLine + i).padStart(5)}| ${l}`)
    .join('\n');
}

/** Keep prompt size bounded for very large files by windowing around the finding. */
function truncateAroundLine(content: string, line?: number): { text: string; startLine: number } {
  if (content.length <= MAX_FILE_CHARS) return { text: content, startLine: 1 };
  const lines = content.split('\n');
  const center = Math.min(Math.max((line ?? 1) - 1, 0), lines.length - 1);
  const radius = 400;
  const start = Math.max(0, center - radius);
  const end = Math.min(lines.length, center + radius);
  return { text: lines.slice(start, end).join('\n'), startLine: start + 1 };
}
