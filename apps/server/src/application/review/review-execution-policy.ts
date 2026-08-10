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

/** GitHub lifecycle checks are authoritative but must not exhaust installation API quota. */
export function resolvePrStatePollMs(ownershipHeartbeatMs: number): number {
  const boundedHeartbeat = Number.isFinite(ownershipHeartbeatMs)
    ? Math.max(1_000, Math.floor(ownershipHeartbeatMs))
    : 5_000;
  return Math.max(30_000, boundedHeartbeat);
}

export function takeReviewCallsByPriority<T>(
  core: readonly T[],
  optional: readonly T[],
  maxCalls: number,
): T[] {
  // Required coverage is never silently dropped. The execution budget limits
  // optional sweeps, probes, and repeated samples only; a future hard ceiling
  // must reject before provider spend rather than publishing a sampled review.
  const optionalSlots = Math.max(0, Math.floor(maxCalls) - core.length);
  return [...core, ...optional.slice(0, optionalSlots)];
}
