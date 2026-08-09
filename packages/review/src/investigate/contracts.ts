import { z } from 'zod';
import type { LlmAttemptEvent } from '../llm-client.js';
import type { ReviewPromptContext } from '../prompt.js';

export interface InvestigateOptions {
  /** Absolute path to a repo checkout. All tool paths are confined under this. */
  cwd: string;
  apiKey: string;
  model: string;
  baseUrl?: string;
  api?: 'chat' | 'responses' | 'anthropic';
  reasoningEffort?: string;
  maxTokens?: number;
  /** Cancel the tool loop and any active provider call when the PR closes. */
  signal?: AbortSignal;
  context?: ReviewPromptContext;
  onUsage?: (usage: {
    inputTokens: number;
    outputTokens: number;
    tokenSource?: 'provider' | 'estimate';
    provider?: string;
    model?: string;
    attemptId?: string;
  }) => void;
  onAttempt?: (event: LlmAttemptEvent) => void;
  /** Max tool rounds before forcing a done response. Default 8. */
  maxSteps?: number;
  /** Cap on a single tool result returned to the model. */
  maxToolOutputChars?: number;
}

export const ToolCallSchema = z.discriminatedUnion('name', [
  z.object({
    name: z.literal('list_dir'),
    path: z.string().default('.'),
  }),
  z.object({
    name: z.literal('read_file'),
    path: z.string().min(1),
    offset: z.number().int().nonnegative().optional(),
    limit: z.number().int().positive().optional(),
  }),
  z.object({
    name: z.literal('grep'),
    pattern: z.string().min(1).max(400),
    path: z.string().optional(),
    glob: z.string().max(120).optional(),
    caseInsensitive: z.boolean().optional(),
  }),
  z.object({
    name: z.literal('find_callers'),
    symbol: z.string().min(1).max(160),
    path: z.string().optional(),
  }),
  z.object({
    name: z.literal('find_tests'),
    path: z.string().min(1),
  }),
]);

export type InvestigateToolCall = z.infer<typeof ToolCallSchema>;

export const StepSchema = z.union([
  z.object({
    action: z.literal('tool'),
    tool: ToolCallSchema,
    reason: z.string().optional(),
  }),
  z.object({
    action: z.literal('done'),
    findings: z.array(z.unknown()).optional(),
    summary: z.string().optional(),
  }),
]);

export type InvestigateStep = z.infer<typeof StepSchema>;
