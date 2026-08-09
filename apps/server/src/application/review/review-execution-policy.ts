import type { ReviewAggregationConfig } from '@orvex-review/review';

export interface ReviewExecutionPolicy {
  abortPollMs: number;
  maxCalls: number;
  concurrency: number;
  maxOtherChars: number;
  sweepFileChars: number;
  maxInlinePerPr: number;
  aggregation: ReviewAggregationConfig;
}

export function takeReviewCallsByPriority<T>(
  core: readonly T[],
  optional: readonly T[],
  maxCalls: number,
): T[] {
  return [...core, ...optional].slice(0, Math.max(0, Math.floor(maxCalls)));
}
