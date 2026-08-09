import { minimatch } from 'minimatch';
import { z } from 'zod';
import { parse as parseYaml } from 'yaml';

export const ReviewConfigSchema = z.object({
  mode: z.enum(['strict', 'normal']).default('normal'),
  ignore: z.array(z.string()).default([]),
  include_docs: z.boolean().default(false),
  max_comments: z.number().int().min(1).max(100).default(25),
  run_semgrep: z.boolean().default(true),
  ignore_labels: z.array(z.string()).default(['review-bot:ignore']),
  // Medium (P3) findings are real bugs, not nitpicks — surfaced inline by default
  // so the "catch critical/high/medium" goal is met. A team that wants a quieter
  // thread can set fold_medium:true in .orvex-review.yml to collapse P3 into the
  // folded section alongside low/info. Only `info` is ever folded when false.
  fold_medium: z.boolean().default(false),
});

export type ReviewConfig = z.infer<typeof ReviewConfigSchema>;

export const DEFAULT_REVIEW_CONFIG: ReviewConfig = ReviewConfigSchema.parse({});

export function parseReviewConfigYaml(raw: string | null | undefined): ReviewConfig {
  if (!raw?.trim()) return { ...DEFAULT_REVIEW_CONFIG };
  let doc: unknown;
  try {
    doc = parseYaml(raw);
  } catch (err) {
    // Never silently discard: a malformed .orvex-review.yml falling back to
    // defaults with no signal leaves the repo owner thinking their ignore list
    // / thresholds are active when none are.
    console.warn(
      `[config] .orvex-review.yml is not valid YAML — using defaults: ${(err as Error).message}`,
    );
    return { ...DEFAULT_REVIEW_CONFIG };
  }
  const parsed = ReviewConfigSchema.safeParse(doc ?? {});
  if (!parsed.success) {
    console.warn(
      `[config] .orvex-review.yml failed validation — using defaults: ${parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    );
    return { ...DEFAULT_REVIEW_CONFIG };
  }
  return parsed.data;
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
