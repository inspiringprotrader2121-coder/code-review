import { minimatch } from 'minimatch';
import { z } from 'zod';
import { parse as parseYaml } from 'yaml';

export const ReviewConfigSchema = z.object({
  mode: z.enum(['strict', 'normal']).default('normal'),
  ignore: z.array(z.string()).default([]),
  include_docs: z.boolean().default(false),
  max_comments: z.number().int().min(1).max(50).default(8),
  max_tokens: z.number().int().min(1000).default(50_000),
  min_confidence: z.number().min(0).max(1).default(0.6),
  inline_min_confidence: z.number().min(0).max(1).default(0.7),
  run_semgrep: z.boolean().default(true),
  ignore_labels: z.array(z.string()).default(['review-bot:ignore']),
});

export type ReviewConfig = z.infer<typeof ReviewConfigSchema>;

export const DEFAULT_REVIEW_CONFIG: ReviewConfig = ReviewConfigSchema.parse({});

export function parseReviewConfigYaml(raw: string | null | undefined): ReviewConfig {
  if (!raw?.trim()) return { ...DEFAULT_REVIEW_CONFIG };
  try {
    const doc = parseYaml(raw);
    return ReviewConfigSchema.parse(doc ?? {});
  } catch {
    return { ...DEFAULT_REVIEW_CONFIG };
  }
}

export function shouldIgnorePath(filename: string, config: ReviewConfig): boolean {
  for (const pattern of config.ignore) {
    if (minimatch(filename, pattern)) return true;
  }
  if (!config.include_docs && /\.md$/i.test(filename)) {
    if (/audit|slice-/i.test(filename)) {
      // still scan audit docs with rules even when include_docs false
      return false;
    }
    return true;
  }
  return false;
}
