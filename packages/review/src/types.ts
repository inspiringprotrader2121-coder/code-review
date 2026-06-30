import { z } from 'zod';

export const FindingSchema = z.object({
  file: z.string(),
  line: z.number().int().positive().optional(),
  severity: z.enum(['P1', 'P2', 'P3', 'info']),
  category: z.string(),
  message: z.string(),
  suggestion: z.string().optional(),
  confidence: z.number().min(0).max(1),
});

export const LlmReviewResponseSchema = z.object({
  findings: z.array(FindingSchema),
  summary: z.string().optional(),
});

export type Finding = z.infer<typeof FindingSchema>;
export type LlmReviewResponse = z.infer<typeof LlmReviewResponseSchema>;

export interface ReviewableFile {
  filename: string;
  status: string;
  patch?: string;
  truncated?: boolean;
}

export interface DiffInput {
  filename: string;
  status: string;
  patch?: string;
}
