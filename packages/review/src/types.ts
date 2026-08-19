import { z } from 'zod';

export const FindingSchema = z.object({
  file: z.string(),
  line: z.number().int().positive().optional(),
  severity: z.enum(['P1', 'P2', 'P3', 'info']),
  category: z.string(),
  message: z.string(),
  suggestion: z.string().optional(),
  originalCode: z.string().optional(),
  fixedCode: z.string().optional(),
  confidence: z.number().min(0).max(1),
  ruleId: z.string().optional(),
});

export const LlmReviewResponseSchema = z.object({
  findings: z.array(FindingSchema),
  summary: z.string().optional(),
});

export const FindingJsonSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    file: { type: 'string', pattern: '^[\\s\\S]*\\S[\\s\\S]*$' },
    line: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] },
    severity: { type: 'string', enum: ['P1', 'P2', 'P3', 'info'] },
    category: { type: 'string' },
    message: { type: 'string', pattern: '^[\\s\\S]*\\S[\\s\\S]*$' },
    suggestion: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    originalCode: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    fixedCode: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    ruleId: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  },
  required: [
    'file',
    'line',
    'severity',
    'category',
    'message',
    'suggestion',
    'originalCode',
    'fixedCode',
    'confidence',
    'ruleId',
  ],
  additionalProperties: false,
};

/** DeepSeek Responses structured-output contract for discovery stages. */
export const LlmReviewResponseJsonSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    findings: { type: 'array', items: FindingJsonSchema },
    summary: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  },
  required: ['findings', 'summary'],
  additionalProperties: false,
};

export type Finding = z.infer<typeof FindingSchema>;
export type LlmReviewResponse = z.infer<typeof LlmReviewResponseSchema>;

export interface ReviewableFile {
  filename: string;
  status: string;
  patch?: string;
  truncated?: boolean;
}
