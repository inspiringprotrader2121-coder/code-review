import { z } from 'zod';
import type { LlmAttemptEvent } from '../llm-client.js';
import type { ReviewPromptContext } from '../prompt.js';
import { FindingJsonSchema } from '../types.js';

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
    cachedInputTokens?: number;
    cacheWriteTokens?: number;
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
    action: z.enum(['done', 'final']),
    findings: z.array(z.unknown()),
    summary: z.string().optional(),
  }),
]);

const InvestigateToolJsonSchema: Record<string, unknown> = {
  anyOf: [
    {
      type: 'object',
      properties: {
        name: { type: 'string', enum: ['list_dir'] },
        path: { type: 'string' },
      },
      required: ['name', 'path'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        offset: { anyOf: [{ type: 'integer', minimum: 0 }, { type: 'null' }] },
        limit: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] },
        path: { type: 'string', pattern: '^[\\s\\S]+$' },
        name: { type: 'string', enum: ['read_file'] },
      },
      required: ['name', 'path', 'offset', 'limit'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        pattern: { type: 'string', pattern: '^[\\s\\S]{1,400}$' },
        path: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        glob: {
          anyOf: [{ type: 'string', pattern: '^[\\s\\S]{0,120}$' }, { type: 'null' }],
        },
        caseInsensitive: { anyOf: [{ type: 'boolean' }, { type: 'null' }] },
        name: { type: 'string', enum: ['grep'] },
      },
      required: ['name', 'pattern', 'path', 'glob', 'caseInsensitive'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        symbol: { type: 'string', pattern: '^[\\s\\S]{1,160}$' },
        path: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        name: { type: 'string', enum: ['find_callers'] },
      },
      required: ['name', 'symbol', 'path'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        path: { type: 'string', pattern: '^[\\s\\S]+$' },
        name: { type: 'string', enum: ['find_tests'] },
      },
      required: ['name', 'path'],
      additionalProperties: false,
    },
  ],
};

/** Final investigate turn cannot degrade into a tool call or summary-only object. */
export const InvestigateFinalJsonSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    findings: { type: 'array', items: FindingJsonSchema },
    action: { type: 'string', enum: ['done', 'final'] },
    summary: { type: 'string' },
  },
  required: ['action', 'findings', 'summary'],
  additionalProperties: false,
};

const InvestigateBareFinalJsonSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    findings: { type: 'array', items: FindingJsonSchema },
    summary: { type: 'string' },
  },
  required: ['findings', 'summary'],
  additionalProperties: false,
};

const InvestigateStepPayloadJsonSchema: Record<string, unknown> = {
  anyOf: [
    {
      type: 'object',
      properties: {
        tool: InvestigateToolJsonSchema,
        action: { type: 'string', enum: ['tool'] },
        reason: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      },
      required: ['action', 'tool', 'reason'],
      additionalProperties: false,
    },
    InvestigateFinalJsonSchema,
  ],
};

const InvestigateStepEnvelopeJsonSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    step: InvestigateStepPayloadJsonSchema,
  },
  required: ['step'],
  additionalProperties: false,
};

/**
 * Any investigate turn may be a tool step or an immediate final review.
 * Structured output must allow both; turn 1 is not required to wrap `step`.
 */
export const InvestigateStepJsonSchema: Record<string, unknown> = {
  anyOf: [
    InvestigateStepEnvelopeJsonSchema,
    ...(InvestigateStepPayloadJsonSchema.anyOf as Record<string, unknown>[]),
    InvestigateBareFinalJsonSchema,
  ],
};

export type InvestigateStep = z.infer<typeof StepSchema>;
